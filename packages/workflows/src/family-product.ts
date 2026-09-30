import {
  KnownFormulaSchema,
  type PipelineActivities,
  type ProductPipelineInput,
} from "./pipeline-model.js";

/** Shared external-ID formulas: capture already recorded metrics before lookup or queueing. */
export async function collectFamilyProduct(
  input: ProductPipelineInput,
  pipeline: PipelineActivities,
  captured: { listingId: string; variantId: string | null },
): Promise<unknown> {
  const { listingId, variantId } = captured;
  const request = { runId: input.runId, channel: input.channel, listingId, variantId };
  const known = KnownFormulaSchema.parse(await pipeline.findKnownFormula(request));
  if (known) {
    return { status: "collected", reusedFormula: true, operationId: known.operationId, listingId };
  }
  // Metrics are saved and the Amazon product is queued; its formula links by ASIN when it arrives. Not a Review.
  await pipeline.requestAmazonFormula({ brandId: input.brandId, listingId });
  return { status: "collected", reusedFormula: false, formulaPending: true, listingId };
}
