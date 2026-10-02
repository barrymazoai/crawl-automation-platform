import { PostgresSiteAnalyses } from "@crawl-automation/adapters";
import type { Database } from "@crawl-automation/platform";
import { costcoAdapter } from "@crawl-automation/channels-costco";
import {
  createDtcAdapter,
  storedDtcSites,
  type DtcSitePolicy,
} from "@crawl-automation/channel-dtc";
import {
  wholeFoodsAdapter,
  WHOLE_FOODS_STORE,
  type WholeFoodsHttpScanSettings,
} from "@crawl-automation/channels-wholefoods";
import { amazonAdapter } from "@crawl-automation/channel-amazon";
import {
  createSwansonAdapter,
  type SwansonBrandScanSettings,
} from "@crawl-automation/channel-swanson";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import { gncAdapter } from "@crawl-automation/channels-gnc";

/** The channels whose product pages this API reads addresses of (product and list runs). */
export function channelRegistry(
  dtcSites: readonly DtcSitePolicy[] = [],
  swanson?: SwansonBrandScanSettings,
  wholefoods?: WholeFoodsHttpScanSettings,
): ChannelRegistry {
  return new ChannelRegistry([
    createSwansonAdapter(swanson),
    gncAdapter,
    amazonAdapter,
    wholeFoodsAdapter(WHOLE_FOODS_STORE, wholefoods),
    costcoAdapter(),
    createDtcAdapter(dtcSites),
  ]);
}

/** Sources discovered through the API become visible without editing config or restarting. */
export function persistedRegistry(
  database: Database,
  sites: readonly DtcSitePolicy[],
  registry = channelRegistry(sites),
) {
  const store = new PostgresSiteAnalyses(database);
  return registry.withRefresh(async () => [
    createDtcAdapter(storedDtcSites(sites, await store.settings())),
  ]);
}
