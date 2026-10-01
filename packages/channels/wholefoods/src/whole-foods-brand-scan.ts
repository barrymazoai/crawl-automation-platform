import { BrowserListingScan, type ScanBrowser } from "@crawl-automation/channels-core";
import type { ObjectStore } from "@crawl-automation/platform";
import { wholeFoodsBrandSourceUrl } from "./whole-foods-address.js";
import { WHOLE_FOODS_LIST_SCROLL, WHOLE_FOODS_PAGE_POLICY } from "./whole-foods-policy.js";
import { parseWholeFoodsListing } from "./whole-foods-listing.js";
import { wholeFoodsErrors } from "./whole-foods-errors.js";
import {
  WHOLE_FOODS_SCAN_DEFAULTS,
  type WholeFoodsScanSettings,
} from "./whole-foods-scan-settings.js";
import type { WholeFoodsStore } from "./whole-foods-store.js";

export type { BrowserBrandScan, ScanBrowser } from "@crawl-automation/channels-core";
export interface WholeFoodsBrandScanDeps {
  browser: ScanBrowser;
  remote: ObjectStore;
  store: WholeFoodsStore;
  settings?: WholeFoodsScanSettings;
}

/** Whole Foods policy on the shared archived, paced browser listing scan. */
export class WholeFoodsBrandScan extends BrowserListingScan {
  constructor(deps: WholeFoodsBrandScanDeps) {
    const settings = deps.settings ?? WHOLE_FOODS_SCAN_DEFAULTS;
    super({
      ...deps,
      sourceUrl: wholeFoodsBrandSourceUrl,
      maxBytes: WHOLE_FOODS_PAGE_POLICY.maxBytes,
      policy: WHOLE_FOODS_PAGE_POLICY,
      scroll: { ...WHOLE_FOODS_LIST_SCROLL, pressDelayMs: settings.pressDelayMs },
      canaryUrl: settings.canaryUrl,
      storeId: deps.store.storeId,
      readySelector: "main",
      parse: (html, observed) => parseWholeFoodsListing(html, deps.store, observed),
      isUnverified: (error) => wholeFoodsErrors.is(error, "WHOLEFOODS.LISTING_UNVERIFIED"),
      throttled: (archiveKeys, cause) =>
        wholeFoodsErrors.create("WHOLEFOODS.SEARCH_THROTTLED", {
          cause,
          details: { cooldownRequested: true, archiveKeys },
        }),
    });
  }
}
