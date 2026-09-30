import { amazonAdapter } from "@crawl-automation/channel-amazon";
import { configuredDtcSites, createDtcAdapter } from "@crawl-automation/channel-dtc";
import { swansonAdapter } from "@crawl-automation/channel-swanson";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import { gncAdapter } from "@crawl-automation/channels-gnc";
import type { WorkerConfig } from "./config.js";

/** Planning, formula lookup and file acquisition need the same DTC policies as browser capture. */
export function workerChannelRegistry(config: Pick<WorkerConfig, "browser">): ChannelRegistry {
  return new ChannelRegistry([
    swansonAdapter,
    gncAdapter,
    amazonAdapter,
    createDtcAdapter(configuredDtcSites(config.browser?.dtc)),
  ]);
}
