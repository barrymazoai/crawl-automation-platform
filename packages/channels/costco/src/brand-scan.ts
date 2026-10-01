import {
  BrowserListingReader,
  BrowserListingScan,
  type ScanBrowser,
} from "@crawl-automation/channels-core";
import type { ObjectStore } from "@crawl-automation/platform";
import { costcoBrandSourceUrl } from "./address.js";
import { parseCostcoListing } from "./listing.js";
import { COSTCO_LIST_SCROLL, COSTCO_PAGE_POLICY } from "./policy.js";
import { COSTCO_SCAN_DEFAULTS, type CostcoScanSettings } from "./scan-settings.js";
import { COSTCO_STORE, type CostcoStore } from "./store.js";
import { costcoErrors } from "./errors.js";

function readerOptions(store: CostcoStore) {
  return {
    sourceUrl: costcoBrandSourceUrl,
    maxBytes: COSTCO_PAGE_POLICY.maxBytes,
    parse: (html: string, observed?: readonly { html: string }[]) =>
      parseCostcoListing(html, store, observed),
  };
}
export const costcoBrandReader = (store: CostcoStore) =>
  new BrowserListingReader(readerOptions(store));

/** No store switching or protected catalog API calls: the shared browser read owns the page. */
export class CostcoBrandScan extends BrowserListingScan {
  constructor(deps: {
    browser: ScanBrowser;
    remote: ObjectStore;
    store?: CostcoStore;
    settings?: CostcoScanSettings;
  }) {
    const store = deps.store ?? COSTCO_STORE;
    const settings = deps.settings ?? COSTCO_SCAN_DEFAULTS;
    super({
      ...deps,
      ...readerOptions(store),
      policy: COSTCO_PAGE_POLICY,
      scroll: { ...COSTCO_LIST_SCROLL, pressDelayMs: settings.pressDelayMs },
      canaryUrl: settings.canaryUrl,
      storeId: store.storeId,
      readySelector: "main",
      isUnverified: (error) => costcoErrors.is(error, "COSTCO.LISTING_UNVERIFIED"),
      throttled: (archiveKeys, cause) =>
        costcoErrors.create("COSTCO.SEARCH_THROTTLED", {
          cause,
          details: { cooldownRequested: true, archiveKeys },
        }),
    });
  }
}
