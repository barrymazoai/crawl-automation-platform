import {
  BrandRequestsApi,
  FeishuBrandIntakeAlerts,
  type PostgresBrandEnrichmentRuns,
  type SupplySmartBrandRequests,
} from "@crawl-automation/adapters";
import { BrandRequestIntake } from "@crawl-automation/app";
import type { CoreParts } from "./core-parts.js";

/** KAN-220: built by the brand-enrichment role; undefined when disabled or no operators' API is configured. */
export function buildRequestIntake(
  parts: CoreParts,
  input: { requests: SupplySmartBrandRequests; runs: PostgresBrandEnrichmentRuns },
) {
  const settings = parts.config.brandEnrichment?.requestIntake;
  const apiUrl = settings?.apiUrl ?? parts.config.stopSweep?.apiUrl;
  if (!settings?.enabled || !apiUrl) {
    return undefined;
  }
  const log = parts.log.child({ service: "brand-request-intake" });
  return new BrandRequestIntake({
    waits: input.requests,
    requests: input.requests,
    runs: input.runs,
    api: new BrandRequestsApi(apiUrl),
    alerts: new FeishuBrandIntakeAlerts({ webhookFile: settings.webhookFile, log }),
    settings: {
      maxLiveRuns: settings.maxLiveRuns,
      waitMs: settings.waitSeconds * 1_000,
      timeoutMs: settings.timeoutMinutes * 60_000,
    },
    log,
  });
}
