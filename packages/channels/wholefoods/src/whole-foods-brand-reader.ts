import { BrowserListingReader } from "@crawl-automation/channels-core";
import { wholeFoodsBrandSourceUrl } from "./whole-foods-address.js";
import { parseWholeFoodsListing } from "./whole-foods-listing.js";
import { WHOLE_FOODS_PAGE_POLICY } from "./whole-foods-policy.js";
import type { WholeFoodsStore } from "./whole-foods-store.js";

/** HTML is read after browser capture; only retained scroll proof establishes completeness. */
export class WholeFoodsBrandReader extends BrowserListingReader {
  constructor(store: WholeFoodsStore) {
    super({
      sourceUrl: wholeFoodsBrandSourceUrl,
      maxBytes: WHOLE_FOODS_PAGE_POLICY.maxBytes,
      parse: (html, observed) => parseWholeFoodsListing(html, store, observed),
    });
  }
}
