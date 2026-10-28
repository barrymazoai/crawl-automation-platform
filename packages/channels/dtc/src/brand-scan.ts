import type { BrowserScanRequest } from "@crawl-automation/channels-core";
import {
  brandScanErrors,
  platformPageErrors,
  readShopifyCatalogPage,
  type ListingPage,
  type ListedProduct,
} from "@crawl-automation/channels-core";
import { dtcProductAddress, shopifyCatalogPageUrl, siteForBrandUrl } from "./address.js";
import type { DtcCatalogPages } from "./catalog-pages.js";
import { dtcDocument } from "./product.js";
import { DTC_SITES, type DtcSitePolicy } from "./site-policy.js";
import { dtcBrandSource, type DtcBrandSource } from "./brand-source.js";
import { dtcBrandEvidence, type DtcBrandEvidence } from "./brand-evidence.js";

export interface DtcListedProduct extends ListedProduct {
  productId?: string;
  brand: string;
  seller: string;
  brandBasis: "page" | "source";
  brandEvidence: DtcBrandEvidence;
  /** The store's own filing, for the scan's supplement judgement; absent where the scan cannot read it. */
  productTitle?: string;
  productType?: string | null;
  tags?: string[];
}

export interface DtcListingPage extends ListingPage {
  products: DtcListedProduct[];
}

export interface DtcBrandScanResult {
  sourceUrl: string;
  source: DtcBrandSource;
  pages: DtcListingPage[];
  complete: boolean;
  soldHere: boolean;
  archiveKeys: string[];
  stopped: "end" | "scroll_limit" | "page_limit";
}

function listingPage(
  products: ReturnType<typeof readShopifyCatalogPage>,
  scope: { site: DtcSitePolicy; source: DtcBrandSource },
  position: number,
): DtcListingPage {
  const { site, source } = scope;
  return {
    products: products.flatMap((product) =>
      product.variants.map((variant) => {
        const url = new URL(`/products/${product.handle}`, source.catalogUrl);
        url.searchParams.set("variant", variant.id);
        return {
          ...dtcProductAddress(url.href, [site]),
          productId: product.productId,
          title:
            variant.title === "Default Title"
              ? product.title
              : `${product.title} - ${variant.title}`,
          kind: "product" as const,
          brand: site.kind === "single-brand" ? source.brand : (product.brandRaw ?? source.brand),
          seller: site.siteKey,
          brandBasis:
            site.kind === "multi-brand" && product.brandRaw
              ? ("page" as const)
              : ("source" as const),
          brandEvidence: dtcBrandEvidence(site, product.brandRaw, source),
          productTitle: product.title,
          productType: product.productType,
          tags: product.tags,
        };
      }),
    ),
    cards: products.length,
    nextPage: products.length === 250 ? position + 1 : null,
    statedTotal: null,
  };
}

function initialState(source: DtcBrandSource): DtcBrandScanResult {
  return {
    sourceUrl: source.catalogUrl,
    source,
    pages: [],
    complete: false,
    soldHere: true,
    archiveKeys: [],
    stopped: "page_limit",
  };
}

/** The browser renders products.json inside a <pre>; the retained original stays exactly what it returned. */
function catalogJson(html: string): string | undefined {
  return html.trimStart().startsWith("<")
    ? (dtcDocument(html).querySelector("pre")?.textContent ?? undefined)
    : html;
}

function verifiedProducts(
  read: { url: string; status: number | null; html: string },
  url: string,
  seen: Set<string>,
) {
  if (read.url !== url || (read.status !== null && read.status !== 200)) {
    throw platformPageErrors.create("DTC.CATALOG_HTTP_STATUS", {
      details: { status: read.status, finalUrl: read.url },
    });
  }
  const products = readShopifyCatalogPage(catalogJson(read.html));
  if (products.length > 250) {
    throw platformPageErrors.create("DTC.CATALOG_JSON_INVALID");
  }
  if (products.length && products.every((product) => seen.has(product.productId))) {
    throw brandScanErrors.create("BRAND_SCAN.PAGINATION");
  }
  for (const product of products) {
    seen.add(product.productId);
  }
  return products;
}

/** Separate browser scan, like Whole Foods; never attached to the HTTP-only BrandScanReader hook. */
export class DtcBrandScan {
  constructor(
    private readonly deps: {
      pages: Pick<DtcCatalogPages, "read">;
      sites?: readonly DtcSitePolicy[];
      maxPages?: number;
    },
  ) {}

  async scan(request: BrowserScanRequest, signal: AbortSignal): Promise<DtcBrandScanResult> {
    const site = siteForBrandUrl(request.sourceUrl, this.deps.sites ?? DTC_SITES);
    if (site.platform !== "shopify") {
      throw platformPageErrors.create("DTC.PLATFORM_UNVERIFIED");
    }
    const source = dtcBrandSource(request.sourceUrl, [site]);
    const state = initialState(source);
    const seen = new Set<string>();
    for (let position = 1; position <= (this.deps.maxPages ?? 100); position += 1) {
      signal.throwIfAborted();
      await request.checkpoint?.();
      const url = shopifyCatalogPageUrl(source.catalogUrl, site, position);
      const read = await this.deps.pages.read({ ...request, position, url, site }, signal);
      const products = verifiedProducts(read, url, seen);
      state.pages.push(listingPage(products, { site, source }, position));
      state.archiveKeys.push(read.archiveKey);
      if (products.length < 250) {
        return { ...state, complete: true, stopped: "end" };
      }
    }
    return state;
  }
}
