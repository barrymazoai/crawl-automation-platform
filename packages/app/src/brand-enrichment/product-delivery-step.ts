import type { SiteAnalysisApplyResult } from "../site-analysis/site-analysis-service.js";
import type { ProductDelivery } from "./task-ports.js";
import { domainOf } from "./run-records.js";
import { brandEnrichmentErrors } from "./errors.js";

export interface BrandDeliveryInput {
  runId: string;
  companyId: string;
  /** The catalog the products came from: the brand URL, or an absorbed brand's collection. */
  url: string;
  applied: SiteAnalysisApplyResult;
}

/**
 * One delivery of a brand's settled DTC products, shared by the products track and a later
 * `brandEnrichment.deliverProducts`. The ingest run ID is the run's, so a second delivery is the same Supply Smart
 * run (idempotent), never a new one.
 */
export async function deliverBrandProducts(
  delivery: ProductDelivery,
  input: BrandDeliveryInput,
  signal: AbortSignal,
) {
  const sourceIds = [...new Set((input.applied.tasks ?? []).map((task) => task.sourceId))];
  const siteKey = domainOf(input.url);
  if (!siteKey) {
    throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.IDENTITY_UNRESOLVED");
  }
  if (!sourceIds.length) {
    return {
      captured: 0,
      review: 0,
      reason: "No verified DTC sources",
      skipped: input.applied.skipped,
    };
  }
  // The reader takes a snapshot before the network delivery finishes. Keep that lower bound so a
  // product completing during delivery remains eligible for the next sweep.
  const deliveryStartedAt = new Date().toISOString();
  const result = await delivery.deliver(
    {
      companyId: input.companyId,
      siteKey,
      sourceIds,
      ingestRunId: `brand-enrichment-${input.runId}`,
    },
    signal,
  );
  return { ...result, deliveryStartedAt };
}
