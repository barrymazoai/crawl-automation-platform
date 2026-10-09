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
  SupplySmartProductDelivery,
} from "@crawl-automation/adapters";
import { BrandEnrichmentService, BrandProductRedelivery } from "@crawl-automation/app";
import { BrandEnrichmentWorkflowSettingsSchema } from "@crawl-automation/v3-contracts";
import type { Database, ObjectStore, TemporalClient } from "@crawl-automation/platform";

export const ApiBrandEnrichmentSchema = BrandEnrichmentWorkflowSettingsSchema.safeExtend({
  secretsFile: z.string().refine(isAbsolute, "Must be an absolute path"),
});

/** Composition root only: reads private credentials lazily; no intake or background polling. */
export async function brandEnrichmentService(parts: {
  database: Database;
  temporal: TemporalClient;
  config: { brandEnrichment?: z.infer<typeof ApiBrandEnrichmentSchema> | undefined };
  /** Saved product projections in R2; without them this API cannot deliver products. */
  storageReaders?: { objects: Pick<ObjectStore, "read"> } | null;
}) {
  const settings = parts.config.brandEnrichment;
  if (!settings) {
    return undefined;
  }
  const secrets = await loadBrandEnrichmentSecrets(settings.secretsFile);
  const rpc = new SupplySmartRpc(secrets.supplySmart);
  const { secretsFile: _secretsFile, ...workflowSettings } = settings;
  const runs = new PostgresBrandEnrichmentRuns(parts.database);
  const objects = parts.storageReaders?.objects;
  return new BrandEnrichmentService({
    ...(objects
      ? {
          redelivery: new BrandProductRedelivery({
            runs,
            delivery: new SupplySmartProductDelivery({ database: parts.database, rpc, objects }),
          }),
        }
      : {}),
    runs,
    reviews: new PostgresBrandEnrichmentReviews(parts.database),
    requests: new SupplySmartBrandRequests(rpc),
    companies: new SupplySmartCompaniesClient(rpc),
    gateway: new TemporalBrandEnrichment(parts.temporal.client, workflowSettings),
  });
}
