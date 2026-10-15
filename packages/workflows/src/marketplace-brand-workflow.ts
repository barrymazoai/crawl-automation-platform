import {
  BrandEnrichmentWorkflowInputSchema,
  type BrandEnrichmentWorkflowInput,
} from "@crawl-automation/v3-contracts";
import { CancellationScope, isCancellation } from "@temporalio/workflow";
import { brandEnrichmentActivities } from "./brand-enrichment-routing.js";

/**
 * Owner 2026-10-15: one of our brands whose marketplace products wait for a Supply Smart company. Website lookup →
 * the brand-enrichment identity rule (found: link only; not found: create; never merge) → the brand's match for the
 * product sync. No family, research, Apollo, products or ownership; no automatic retries; one close path.
 */
export async function MarketplaceBrandWorkflow(raw: BrandEnrichmentWorkflowInput): Promise<void> {
  const { runId, settings } = BrandEnrichmentWorkflowInputSchema.parse(raw);
  const { plain, gated } = brandEnrichmentActivities(settings);
  let state: "completed" | "failed" | "cancelled" = "completed";
  let reason: string | undefined;
  try {
    await gated("brandWebsite", { runId });
    await plain.brandIdentity({ runId });
    await plain.brandMarketplaceMatch({ runId });
  } catch (error) {
    state = isCancellation(error) ? "cancelled" : "failed";
    reason = String(error).slice(0, 1000);
    throw error;
  } finally {
    await CancellationScope.nonCancellable(() =>
      plain.brandClose({ runId, state, ...(reason ? { reason } : {}) }),
    );
  }
}
