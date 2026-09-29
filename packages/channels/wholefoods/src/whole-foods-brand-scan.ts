import type { ListingPage } from "@crawl-automation/channels-core";
import type { BrowserPage, BrowserRead, ObjectStore } from "@crawl-automation/platform";
import { wholeFoodsBrandSourceUrl } from "./whole-foods-address.js";
import { ListingArchive } from "./whole-foods-listing-archive.js";
import { WHOLE_FOODS_PRODUCT_LINK, parseWholeFoodsListing } from "./whole-foods-listing.js";
import { WHOLE_FOODS_LIST_SCROLL, WHOLE_FOODS_PAGE_POLICY } from "./whole-foods-policy.js";
import type { WholeFoodsStore } from "./whole-foods-store.js";

/** The browser as a scan needs it: one page read in a task page that is closed before it returns. */
export interface ScanBrowser {
  readonly provider: string;
  read(request: BrowserRead, signal: AbortSignal): Promise<BrowserPage>;
}

export interface WholeFoodsBrandScanDeps {
  browser: ScanBrowser;
  remote: ObjectStore;
  store: WholeFoodsStore;
}

/** What a brand scan found, in the brand-scan service's own page shape. */
export interface BrowserBrandScan {
  sourceUrl: string;
  pages: ListingPage[];
  /**
   * Complete only when the browser scrolled the list to its end (no new products and no "load more" left). A list
   * stopped at the round limit is partial and never suggests that a missing product is unlisted.
   */
  complete: boolean;
  /** False when the search has no results: the brand is not sold at this store. */
  soldHere: boolean;
  archiveKeys: string[];
}

/**
 * A Whole Foods brand scan: the brand's filtered search page, drawn in the browser for the configured store and
 * scrolled to its end, archived in R2, then read. Whole Foods pages cannot be fetched through ScraperAPI (drawn by
 * script, priced by the chosen store), one of the two owner-approved browser cases.
 */
export class WholeFoodsBrandScan {
  constructor(private readonly deps: WholeFoodsBrandScanDeps) {}

  async scan(
    request: { scanId: string; sourceUrl: string },
    signal: AbortSignal,
  ): Promise<BrowserBrandScan> {
    const url = wholeFoodsBrandSourceUrl(request.sourceUrl);
    const place = {
      scanId: request.scanId,
      label: "search",
      maxBytes: WHOLE_FOODS_PAGE_POLICY.maxBytes,
    };
    const archive = new ListingArchive(this.deps.remote, place);
    const saved = (await archive.inspect(signal)) ?? (await this.draw(url, archive, signal));
    const listing = parseWholeFoodsListing(saved.html, this.deps.store);
    return {
      sourceUrl: url,
      pages: [listing.page],
      complete: saved.record.scroll.ended === "stable",
      soldHere: listing.soldHere,
      archiveKeys: [saved.key],
    };
  }

  private async draw(url: string, archive: ListingArchive, signal: AbortSignal) {
    const { browser, store } = this.deps;
    const read: BrowserRead = {
      url,
      readySelector: WHOLE_FOODS_PRODUCT_LINK,
      timeoutMs: WHOLE_FOODS_PAGE_POLICY.timeoutMs,
      scroll: WHOLE_FOODS_LIST_SCROLL,
    };
    const page = await browser.read(read, signal);
    return archive.save({ page, url, provider: browser.provider, storeId: store.storeId }, signal);
  }
}
