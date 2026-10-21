import { isCancellation, log } from "@temporalio/workflow";
import { failureCode } from "./failure-code.js";
import type { PipelineActivities, ProductPipelineInput } from "./pipeline-model.js";

export interface DiscoveredVariantAddress {
  url: string;
  listingId: string;
  variantId: string | null;
}

/** Best effort: a variant that fails to queue never turns the captured product into a Review. */
export async function queueDiscovered(
  input: ProductPipelineInput,
  pipeline: PipelineActivities,
  variants: DiscoveredVariantAddress[],
): Promise<void> {
  const { runId, channel, sourceId } = input;
  try {
    await pipeline.queueDiscoveredVariants({ runId, channel, sourceId, variants });
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    log.warn("Discovered variants were not queued", { runId, code: failureCode(error) });
  }
}
