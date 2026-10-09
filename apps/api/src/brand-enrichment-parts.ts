import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  loadBrandEnrichmentSecrets,
  SupplySmartRpc,
  SupplySmartBrandRequests,
  SupplySmartCompaniesClient,
  PostgresBrandEnrichmentRuns,
  PostgresBrandEnrichmentReviews,
  TemporalBrandEnrichment,
} from "@crawl-automation/adapters";
import { BrandEnrichmentService } from "@crawl-automation/app";
import { BrandEnrichmentWorkflowSettingsSchema } from "@crawl-automation/v3-contracts";
import type { Database, TemporalClient } from "@crawl-automation/platform";

export const ApiBrandEnrichmentSchema = BrandEnrichmentWorkflowSettingsSchema.safeExtend({
  secretsFile: z.string().refine(isAbsolute, "Must be an absolute path"),
});

/** Composition root only: reads private credentials lazily; no intake or background polling. */
export async function brandEnrichmentService(parts: {
  database: Database;
  temporal: TemporalClient;
  config: { brandEnrichment?: z.infer<typeof ApiBrandEnrichmentSchema> | undefined };
}) {
  const settings = parts.config.brandEnrichment;
  if (!settings) {
    return undefined;
  }
  const secrets = await loadBrandEnrichmentSecrets(settings.secretsFile);
  const rpc = new SupplySmartRpc(secrets.supplySmart);
  const { secretsFile: _secretsFile, ...workflowSettings } = settings;
  return new BrandEnrichmentService({
    runs: new PostgresBrandEnrichmentRuns(parts.database),
    reviews: new PostgresBrandEnrichmentReviews(parts.database),
    requests: new SupplySmartBrandRequests(rpc),
    companies: new SupplySmartCompaniesClient(rpc),
    gateway: new TemporalBrandEnrichment(parts.temporal.client, workflowSettings),
  });
}
