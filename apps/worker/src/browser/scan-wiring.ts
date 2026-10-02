import {
  CostcoBrandScan,
  costcoBrandSourceUrl,
  type CostcoStore,
  type CostcoScanSettings,
} from "@crawl-automation/channels-costco";
import {
  createDtcAdapter,
  dtcBrandSourceUrl,
  dtcAgentErrors,
  type DtcSitePolicy,
} from "@crawl-automation/channel-dtc";
import {
  AmazonStoreBrandScan,
  AmazonStorePages,
  amazonStoreSourceUrl,
} from "@crawl-automation/channel-amazon";
import {
  WholeFoodsBrandScan,
  ensureWholeFoodsStore,
  wholeFoodsBrandSourceUrl,
  type WholeFoodsStore,
  type WholeFoodsScanSettings,
} from "@crawl-automation/channels-wholefoods";
import type { EgoPages, RetainedPublication } from "@crawl-automation/platform";
import { acceptsAddress, BrowserScanners, type BrowserScanCapability } from "./browser-scanners.js";

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

function dtcScanner(deps: {
  ego: EgoPages;
  publication: RetainedPublication;
  sites: readonly DtcSitePolicy[];
  scanner?: BrowserScanCapability["scanner"] | undefined;
}): BrowserScanCapability {
  const { sites } = deps;
  const adapter = createDtcAdapter(sites);
  return {
    accepts: (url) =>
      acceptsAddress([(source) => dtcBrandSourceUrl(source, sites), adapter.productAddress], url),
    scanner: {
      scan: (request, signal) => {
        adapter.forBrandSource(request.sourceUrl).scanCapture?.(request.sourceUrl);
        if (!deps.scanner) {
          throw dtcAgentErrors.create("DTC.AGENT_REQUIRED");
        }
        return deps.scanner.scan(request, signal);
      },
    },
  };
}

/** Both Minis use this composition; routing asks URL capabilities, never switches on channel IDs. */
interface BrowserScannerDependencies {
  ego: EgoPages;
  rounds: Pick<EgoPages, "round">;
  beforeRead?: () => Promise<void>;
  publication: RetainedPublication;
  store: WholeFoodsStore;
  dtcSites?: readonly DtcSitePolicy[];
  dtcScanner?: BrowserScanCapability["scanner"];
  wholefoodsScan?: WholeFoodsScanSettings;
  costcoStore?: CostcoStore;
  costcoScan?: CostcoScanSettings;
}

export function buildBrowserScanners(deps: BrowserScannerDependencies): BrowserScanners {
  const { ego, store, publication } = deps;
  const sites = deps.dtcSites ?? [];
  return new BrowserScanners(
    [
      dtcScanner({ ego, publication, sites, scanner: deps.dtcScanner }),
      {
        accepts: (url) => acceptsAddress([costcoBrandSourceUrl], url),
        scanner: new CostcoBrandScan({
          browser: ego,
          remote: publication.remote,
          ...(deps.costcoStore ? { store: deps.costcoStore } : {}),
          ...(deps.costcoScan ? { settings: deps.costcoScan } : {}),
        }),
      },
      {
        accepts: (url) => acceptsAddress([amazonStoreSourceUrl], url),
        scanner: new AmazonStoreBrandScan({
          pages: new AmazonStorePages(deps.rounds),
          publication,
        }),
      },
      {
        accepts: (url) => acceptsAddress([wholeFoodsBrandSourceUrl], url),
        scanner: new WholeFoodsBrandScan({
          browser: ego,
          remote: publication.remote,
          store,
          ...(deps.wholefoodsScan ? { settings: deps.wholefoodsScan } : {}),
        }),
        prepare: storePreparation(ego, store),
      },
    ],
    deps.beforeRead,
  );
}
