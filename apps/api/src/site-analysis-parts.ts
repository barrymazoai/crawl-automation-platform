import { PostgresSiteAnalyses, TemporalSiteAnalyses } from "@crawl-automation/adapters";
import { SiteAnalysisService } from "@crawl-automation/app";
import { SiteAnalysisLimitsSchema } from "@crawl-automation/v3-contracts";
import type { Database, TemporalClient } from "@crawl-automation/platform";
import type { ApiConfig } from "./config.js";
export function siteAnalysisService(parts: {
  database: Database;
  temporal: TemporalClient;
  config: ApiConfig;
}) {
  return new SiteAnalysisService({
    store: new PostgresSiteAnalyses(parts.database),
    gateway: new TemporalSiteAnalyses(parts.temporal.client, parts.config.brandScans?.permits.dtc),
    limits: SiteAnalysisLimitsSchema.parse(parts.config.siteAnalysis ?? {}),
  });
}
