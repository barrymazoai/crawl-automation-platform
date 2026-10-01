import { costcoAdapter } from "@crawl-automation/channels-costco";
import { wholeFoodsAdapter, WHOLE_FOODS_STORE } from "@crawl-automation/channels-wholefoods";
import { amazonAdapter } from "@crawl-automation/channel-amazon";
import { configuredDtcSites, createDtcAdapter } from "@crawl-automation/channel-dtc";
import { createSwansonAdapter } from "@crawl-automation/channel-swanson";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import { gncAdapter } from "@crawl-automation/channels-gnc";
import type { WorkerConfig } from "./config.js";

/** Planning, formula lookup and file acquisition need the same DTC policies as browser capture. */
export function workerChannelRegistry(
  config: Pick<WorkerConfig, "browser" | "brandScans">,
): ChannelRegistry {
  return new ChannelRegistry([
    createSwansonAdapter(config.brandScans?.swanson),
    gncAdapter,
    amazonAdapter,
    wholeFoodsAdapter(WHOLE_FOODS_STORE, config.brandScans?.wholefoods),
    costcoAdapter(),
    createDtcAdapter(configuredDtcSites(config.browser?.dtc)),
  ]);
}
