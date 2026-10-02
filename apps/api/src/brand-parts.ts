import { PostgresBrandStore } from "@crawl-automation/adapters";
import { BrandService } from "@crawl-automation/app";
import { configuredDtcSites } from "@crawl-automation/channel-dtc";
import type { Database, Logger } from "@crawl-automation/platform";
import type { ApiConfig } from "./config.js";
import { persistedRegistry } from "./resources/channel-registry.js";

export function brandService(parts: { database: Database; log: Logger; config: ApiConfig }) {
  return new BrandService({
    brands: new PostgresBrandStore(parts.database),
    log: parts.log,
    registry: persistedRegistry(parts.database, configuredDtcSites(parts.config.browser?.dtc)),
  });
}
