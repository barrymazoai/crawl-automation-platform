import { patched } from "@temporalio/workflow";
import { z } from "zod";
import {
  KnownFormulaSchema,
  type PipelineActivities,
  type ProductPipelineInput,
} from "./pipeline-model.js";

/** Shared external-ID formulas: capture already recorded metrics before lookup or queueing. */
export async function collectFamilyProduct(
  input: ProductPipelineInput,
  pipeline: PipelineActivities,
  captured: { listingId: string; variantId: string | null; archiveKey: string },
): Promise<unknown> {
  const { listingId, variantId } = captured;
  const request = { runId: input.runId, channel: input.channel, listingId, variantId };
  const known = KnownFormulaSchema.parse(await pipeline.findKnownFormula(request));
  if (input.channel === "wholefoods" && patched("family-formula-outcomes-v1")) {
    const result = await pipeline.requestAmazonFormula({
      brandId: input.brandId,
      listingId,
      formulaOperationId: known?.operationId ?? null,
      metrics: {
        operationId: input.operationId,
        runId: input.runId,
        channel: "wholefoods",
        variantId,
        archiveKey: captured.archiveKey,
      },
    });
    return familyOutcome(result, { listingId, metricsOperationId: input.operationId }, known);
  }
  if (known) {
    return { status: "collected", reusedFormula: true, operationId: known.operationId, listingId };
  }
  // Metrics are saved and the Amazon product is queued; its formula links by ASIN when it arrives. Not a Review.
  await pipeline.requestAmazonFormula({ brandId: input.brandId, listingId });
  return { status: "collected", reusedFormula: false, formulaPending: true, listingId };
}

function familyOutcome(
  raw: unknown,
  metrics: { listingId: string; metricsOperationId: string },
  known: { operationId: string } | null,
) {
  const result = z
    .object({
      status: z.enum(["queued", "already-queued", "no-amazon-source", "formula-linked"]),
    })
    .parse(raw);
  const status = known
    ? "formula-linked"
    : result.status === "no-amazon-source"
      ? "no-amazon-source"
      : "formula-pending";
  return {
    status,
    metricsStatus: "metrics-complete",
    ...metrics,
    reusedFormula: !!known,
    formulaPending: status === "formula-pending",
    ...(known ? { operationId: known.operationId } : {}),
  };
}
