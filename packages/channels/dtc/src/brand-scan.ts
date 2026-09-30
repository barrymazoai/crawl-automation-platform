import {
  brandScanErrors,
  platformPageErrors,
  readPlatformCatalog,
  type ListingPage,
  type PlatformCatalog,
} from "@crawl-automation/channels-core";
import { catalogUrl, catalogStartUrl, dtcProductAddress, siteForUrl } from "./address.js";
import type { DtcCatalogPages } from "./catalog-pages.js";
import { dtcDocument } from "./product.js";
import { DTC_SITES, type DtcSitePolicy } from "./site-policy.js";

export interface DtcBrandScanResult {
  sourceUrl: string;
  pages: ListingPage[];
  complete: boolean;
  archiveKeys: string[];
  stopped: "end" | "scroll_limit" | "page_limit";
}

function listingPage(listing: PlatformCatalog, site: DtcSitePolicy, position: number): ListingPage {
  return {
    products: listing.products.map((product) => ({
      ...dtcProductAddress(product.url, [site]),
      title: product.title,
      kind: "product",
    })),
    cards: listing.products.length,
    nextPage: listing.nextUrl ? position + 1 : null,
    statedTotal: null,
  };
}

function initialState(sourceUrl: string): DtcBrandScanResult {
  return { sourceUrl, pages: [], complete: false, archiveKeys: [], stopped: "page_limit" };
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

  async scan(
    request: { scanId: string; sourceUrl: string },
    signal: AbortSignal,
  ): Promise<DtcBrandScanResult> {
    const site = siteForUrl(request.sourceUrl, this.deps.sites ?? DTC_SITES);
    if (site.platform === "unverified") {
      throw platformPageErrors.create("DTC.PLATFORM_UNVERIFIED");
    }
    const sourceUrl = catalogStartUrl(request.sourceUrl, site);
    const state = initialState(sourceUrl);
    const seen = new Set<string>();
    let url = sourceUrl;
    for (let position = 1; position <= (this.deps.maxPages ?? 100); position += 1) {
      signal.throwIfAborted();
      if (seen.has(url)) {
        throw brandScanErrors.create("BRAND_SCAN.PAGINATION");
      }
      seen.add(url);
      const read = await this.deps.pages.read({ ...request, position, url, site }, signal);
      const finalUrl = catalogUrl(read.url, site);
      const listing = readPlatformCatalog(dtcDocument(read.html), {
        ...site.catalog,
        url: finalUrl,
      });
      this.checkRepeated(state.pages, listing);
      state.pages.push(listingPage(listing, site, position));
      state.archiveKeys.push(read.archiveKey);
      if (read.scroll.ended !== "stable") {
        return { ...state, stopped: "scroll_limit" };
      }
      if (!listing.nextUrl) {
        return { ...state, complete: true, stopped: "end" };
      }
      url = catalogUrl(listing.nextUrl, site);
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
