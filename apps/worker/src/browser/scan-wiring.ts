import {
  AmazonStoreBrandScan,
  AmazonStorePages,
  amazonStoreSourceUrl,
} from "@crawl-automation/channel-amazon";
import {
  WholeFoodsBrandScan,
  ensureWholeFoodsStore,
  wholeFoodsBrandSourceUrl,
  wholeFoodsAdapter,
  type WholeFoodsStore,
} from "@crawl-automation/channels-wholefoods";
import type { EgoPages, RetainedPublication } from "@crawl-automation/platform";
import { acceptsAddress, BrowserScanners } from "./browser-scanners.js";
import type { ManagedBrowserRounds } from "./managed-rounds.js";

function storePreparation(browser: EgoPages, store: WholeFoodsStore) {
  let setup: Promise<unknown> | null = null;
  return async (productUrl: string, signal: AbortSignal) => {
    setup ??= ensureWholeFoodsStore(browser, { store, productUrl, timeoutMs: 120_000 }, signal);
    try {
      await setup;
    } catch (error) {
      setup = null;
      throw error;
    }
  };
}

/** Both Minis use this composition; routing asks URL capabilities, never switches on channel IDs. */
export function buildBrowserScanners(deps: {
  ego: EgoPages;
  rounds: ManagedBrowserRounds;
  publication: RetainedPublication;
  store: WholeFoodsStore;
}): BrowserScanners {
  const { ego, store, publication } = deps;
  return new BrowserScanners([
    {
      accepts: (url) => acceptsAddress([amazonStoreSourceUrl], url),
      scanner: new AmazonStoreBrandScan({ pages: new AmazonStorePages(deps.rounds), publication }),
    },
    {
      accepts: (url) =>
        acceptsAddress([wholeFoodsBrandSourceUrl, wholeFoodsAdapter(store).productAddress], url),
      scanner: new WholeFoodsBrandScan({ browser: ego, remote: publication.remote, store }),
      prepare: storePreparation(ego, store),
    },
  ]);
}
