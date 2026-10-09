import type { SiteAnalysisApplyResult } from "../site-analysis/site-analysis-service.js";
import type { ProductDelivery, ProductDeliveryResult } from "./task-ports.js";
import { productDeliveryGroups } from "./product-delivery-groups.js";

export interface BrandDeliveryInput {
  runId: string;
  companyId: string;
  applied: SiteAnalysisApplyResult;
}

/**
 * One delivery of a brand's settled DTC products, shared by the products track and a later
 * `brandEnrichment.deliverProducts`. Each catalog domain gets a stable ingest run, reused on redelivery.
 */
export async function deliverBrandProducts(
  delivery: ProductDelivery,
  input: BrandDeliveryInput,
  signal: AbortSignal,
) {
  const sourceIds = [...new Set((input.applied.tasks ?? []).map((task) => task.sourceId))];
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
  const groups = productDeliveryGroups(sourceIds, await delivery.catalogs(sourceIds, signal));
  const result: ProductDeliveryResult = { captured: 0, review: 0, delivered: 0, refused: [] };
  for (const group of groups) {
    signal.throwIfAborted();
    const delivered = await delivery.deliver(
      {
        ...group,
        companyId: input.companyId,
        ingestRunId: `brand-enrichment-${input.runId}${groups.length > 1 ? `-${group.siteKey}` : ""}`,
      },
      signal,
    );
    result.captured += delivered.captured;
    result.review += delivered.review;
    result.delivered += delivered.delivered;
    result.refused.push(...delivered.refused);
  }
  return { ...result, deliveryStartedAt };
}
