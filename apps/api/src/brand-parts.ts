import { PostgresBrandStore } from "@crawl-automation/adapters";
import { BrandService } from "@crawl-automation/app";
import { configuredDtcSites } from "@crawl-automation/channel-dtc";
import type { Database, Logger } from "@crawl-automation/platform";
import type { ApiConfig } from "./config.js";
import { channelRegistry } from "./resources/channel-registry.js";

export function brandService(parts: { database: Database; log: Logger; config: ApiConfig }) {
  return new BrandService({
    brands: new PostgresBrandStore(parts.database),
    log: parts.log,
    registry: channelRegistry(configuredDtcSites(parts.config.browser?.dtc)),
  });
}
