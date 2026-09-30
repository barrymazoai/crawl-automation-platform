import { brandScanErrors, type BrandScanReader } from "@crawl-automation/channels-core";
import { wholeFoodsBrandSourceUrl } from "./whole-foods-address.js";
import { parseWholeFoodsListing } from "./whole-foods-listing.js";
import { WHOLE_FOODS_PAGE_POLICY } from "./whole-foods-policy.js";
import type { WholeFoodsStore } from "./whole-foods-store.js";

/** HTML is read after browser capture; only retained scroll proof establishes completeness. */
export class WholeFoodsBrandReader implements BrandScanReader {
  readonly sourceUrl = wholeFoodsBrandSourceUrl;
  readonly answer = "html";
  readonly maxPages = 1;
  readonly maxBytes = WHOLE_FOODS_PAGE_POLICY.maxBytes;

  constructor(private readonly store: WholeFoodsStore) {}

  pageUrl(source: string, page: number): string {
    if (page !== 1) {
      throw brandScanErrors.create("BRAND_SCAN.PAGINATION");
    }
    return this.sourceUrl(source);
  }

  parsePage(input: Parameters<BrandScanReader["parsePage"]>[0]) {
    const listing = parseWholeFoodsListing(input.body, this.store);
    return { ...listing.page, soldHere: listing.soldHere };
  }

  complete(): boolean {
    return false;
  }
}
