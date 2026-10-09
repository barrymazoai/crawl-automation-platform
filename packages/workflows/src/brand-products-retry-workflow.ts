import {
  BrandProductsRetryInputSchema,
  type BrandProductsRetryInput,
} from "@crawl-automation/v3-contracts";
import { CancellationScope, isCancellation } from "@temporalio/workflow";
import { brandEnrichmentActivities } from "./brand-enrichment-routing.js";
import { runBrandProducts } from "./brand-enrichment-tracks.js";

/** Only products; the original brand run and Supply Smart request stay closed. */
export async function BrandProductsRetryWorkflow(raw: BrandProductsRetryInput): Promise<void> {
  const input = BrandProductsRetryInputSchema.parse(raw);
  const { plain } = brandEnrichmentActivities(input.settings);
  try {
    await runBrandProducts(input, plain);
  } catch (error) {
    if (isCancellation(error)) {
      await CancellationScope.nonCancellable(() =>
        plain.brandProductsStop({ runId: input.runId, attempt: input.attempt }),
      );
    }
    throw error;
  }
}
