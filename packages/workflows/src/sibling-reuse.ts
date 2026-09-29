import { patched } from "@temporalio/workflow";
import type { ChannelPlanInput } from "@crawl-automation/v3-contracts";
import {
  SiblingReuseResultSchema,
  type CaptureResult,
  type PipelineActivities,
  type ProductPipelineInput,
} from "./pipeline-model.js";

type Captured = Extract<CaptureResult, { status: "captured" }>;

/**
 * Sibling formula reuse: a product with no formula of its own, whose page shows a family, asks whether a size or
 * pack-count sibling's formula fits its label. Only a passed label check links the formula; otherwise the caller
 * extracts as before. Behind a patch marker so histories recorded before it replay unchanged.
 */
export async function reuseSiblingFormula(parts: {
  input: ProductPipelineInput;
  pipeline: PipelineActivities;
  captured: Captured;
}): Promise<unknown> {
  const { input, pipeline, captured } = parts;
  if (captured.family === undefined || captured.family === null) {
    return null;
  }
  if (!patched("formula-reuse-v1")) {
    return null;
  }
  const sourcePlan: ChannelPlanInput = captured.sourcePlan;
  const { listingId, variantId } = sourcePlan.owner;
  const result = SiblingReuseResultSchema.parse(
    await pipeline.reuseSiblingFormula({
      runId: input.runId,
      channel: input.channel,
      listingId,
      variantId,
      family: captured.family,
      labelText: captured.labelText ?? null,
    }),
  );
  if (result.status !== "reused") {
    return null;
  }
  return {
    status: "collected",
    reusedFormula: true,
    operationId: result.formulaOperationId,
    reusedFrom: {
      listingId: result.siblingListingId,
      variantId: result.siblingVariantId,
      linkId: result.linkId,
    },
    observation: sourcePlan.owner,
  };
}
