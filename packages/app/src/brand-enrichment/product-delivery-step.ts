import type { SiteAnalysisApplyResult } from "../site-analysis/site-analysis-service.js";
import type { ProductDelivery, ProductDeliveryResult } from "./task-ports.js";
import { productDeliveryGroups } from "./product-delivery-groups.js";
import { catalogBrandNames, catalogOrder, type OwnSiteFamily } from "./family-catalogs.js";

export interface BrandDeliveryInput {
  runId: string;
  companyId: string;
  applied: SiteAnalysisApplyResult;
  /** KAN-253: products from the brand's own site carry their catalog's brand, not the page vendor. */
  ownSite?: OwnSiteFamily;
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
  const tasks = input.applied.tasks ?? [];
  const brandNames = input.ownSite ? catalogBrandNames(tasks, input.ownSite) : undefined;
  const sourceOrder = input.ownSite ? catalogOrder(tasks, input.ownSite) : undefined;
  const result: ProductDeliveryResult = { captured: 0, review: 0, delivered: 0, refused: [] };
  for (const group of groups) {
    signal.throwIfAborted();
    const delivered = await delivery.deliver(
      {
        ...group,
        companyId: input.companyId,
        ingestRunId: `brand-enrichment-${input.runId}${groups.length > 1 ? `-${group.siteKey}` : ""}`,
        ...ownScans(tasks, group.sourceIds),
        ...(brandNames ? { brandNames } : {}),
        ...(sourceOrder ? { sourceOrder } : {}),
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

/**
 * Only this run's own scans (KAN-253): a later run's products on the same sources are not this run's delivery.
 * Results saved without tasks keep reading every item of their sources.
 */
function ownScans(tasks: readonly { sourceId: string; scanId: string }[], sourceIds: string[]) {
  const scanIds = [
    ...new Set(
      tasks.filter((task) => sourceIds.includes(task.sourceId)).map((task) => task.scanId),
    ),
  ].sort();
  return scanIds.length ? { scanIds } : {};
}
