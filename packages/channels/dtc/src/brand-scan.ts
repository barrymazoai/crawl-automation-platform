import type { BrowserScanRequest } from "@crawl-automation/channels-core";
import {
  brandScanErrors,
  platformPageErrors,
  readPlatformCatalog,
  type ListingPage,
  type ListedProduct,
  type PlatformCatalog,
} from "@crawl-automation/channels-core";
import { catalogUrl, dtcProductAddress, siteForBrandUrl } from "./address.js";
import type { DtcCatalogPages } from "./catalog-pages.js";
import { dtcDocument } from "./product.js";
import { DTC_SITES, type DtcSitePolicy } from "./site-policy.js";
import { dtcBrandSource, type DtcBrandSource } from "./brand-source.js";
import { dtcBrandEvidence, type DtcBrandEvidence } from "./brand-evidence.js";

export interface DtcListedProduct extends ListedProduct {
  brand: string;
  seller: string;
  brandBasis: "page" | "source";
  brandEvidence: DtcBrandEvidence;
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
  listing: PlatformCatalog,
  scope: { site: DtcSitePolicy; source: DtcBrandSource },
  position: number,
): DtcListingPage {
  const { site, source } = scope;
  return {
    products: listing.products.map((product) => ({
      ...dtcProductAddress(product.url, [site]),
      title: product.title,
      kind: "product",
      brand: site.kind === "single-brand" ? source.brand : (product.brandRaw ?? source.brand),
      seller: site.siteKey,
      brandBasis: site.kind === "multi-brand" && product.brandRaw ? "page" : "source",
      brandEvidence: dtcBrandEvidence(site, product.brandRaw, source),
    })),
    cards: listing.products.length,
    nextPage: listing.nextUrl ? position + 1 : null,
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
    if (site.platform === "unverified") {
      throw platformPageErrors.create("DTC.PLATFORM_UNVERIFIED");
    }
    const source = dtcBrandSource(request.sourceUrl, [site]);
    const state = initialState(source);
    const seen = new Set<string>();
    let url = catalogUrl(source.catalogUrl, site, source.catalogUrl);
    for (let position = 1; position <= (this.deps.maxPages ?? 100); position += 1) {
      signal.throwIfAborted();
      await request.checkpoint?.();
      if (seen.has(url)) {
        throw brandScanErrors.create("BRAND_SCAN.PAGINATION");
      }
      seen.add(url);
      const read = await this.deps.pages.read({ ...request, position, url, site }, signal);
      const finalUrl = catalogUrl(read.url, site, source.catalogUrl);
      const listing = readPlatformCatalog(dtcDocument(read.html), {
        ...site.catalog,
        url: finalUrl,
      });
      this.checkRepeated(state.pages, listing);
      state.pages.push(listingPage(listing, { site, source }, position));
      state.archiveKeys.push(read.archiveKey);
      if (read.scroll.ended !== "stable") {
        return { ...state, stopped: "scroll_limit" };
      }
      if (!listing.nextUrl) {
        return { ...state, complete: true, stopped: "end" };
      }
      url = catalogUrl(listing.nextUrl, site, source.catalogUrl);
    }
    return state;
  }

  private checkRepeated(pages: ListingPage[], listing: PlatformCatalog) {
    const known = new Set(pages.flatMap((page) => page.products.map((product) => product.url)));
    if (listing.products.length && listing.products.every((product) => known.has(product.url))) {
      throw brandScanErrors.create("BRAND_SCAN.PAGINATION");
    }
  }
}
