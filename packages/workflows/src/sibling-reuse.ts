import { pipelineErrors } from "@crawl-automation/platform/errors/activity";
import { patched } from "@temporalio/workflow";
import type { ChannelPlanInput } from "@crawl-automation/v3-contracts";
import type { Manifest } from "./label/label-model.js";
import {
  SiblingReuseResultSchema,
  type CaptureResult,
  type PipelineActivities,
  type ProductPipelineInput,
  type SiblingReuseRequest,
} from "./pipeline-model.js";
import { labelImageSelection } from "./sibling-label-image.js";

type Captured = Extract<CaptureResult, { status: "captured" }>;
type ReuseResult = ReturnType<typeof SiblingReuseResultSchema.parse>;

/** The reuse activity's answer when a sibling formula exists but the page prints no facts text to check it with. */
const LABEL_TEXT_UNAVAILABLE = pipelineErrors.code("FORMULA.LABEL_TEXT_UNAVAILABLE");

/**
 * Sibling formula reuse: a product with no formula of its own, whose page shows a family, asks whether a size or
 * pack-count sibling's formula fits its label. Only a passed label check links the formula; otherwise the caller
 * extracts as before. The label is the page's facts text; when the page has none, the facts image read by OCR
 * (behind its own patch marker). Behind a patch marker so histories recorded before it replay unchanged.
 */
export async function reuseSiblingFormula(parts: {
  input: ProductPipelineInput;
  pipeline: PipelineActivities;
  captured: Captured;
  /** The formula plan; when prepared, its sources are the label images an OCR label check reads. */
  plan?: { status: string; manifest?: Manifest };
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
  const request: SiblingReuseRequest = {
    runId: input.runId,
    channel: input.channel,
    listingId,
    variantId,
    family: captured.family,
    labelText: captured.labelText ?? null,
  };
  let result = SiblingReuseResultSchema.parse(await pipeline.reuseSiblingFormula(request));
  const manifest = parts.plan?.status === "prepared" ? parts.plan.manifest : undefined;
  if (needsLabelImage(result, manifest) && patched("formula-reuse-ocr-v1")) {
    result = await checkLabelImage({ input, pipeline, sourcePlan, request, manifest });
  }
  return result.status === "reused" ? collectedFrom(result, sourcePlan) : null;
}

/** The product collected with its sibling's formula, naming the sibling and the link record. */
function collectedFrom(
  result: Extract<ReuseResult, { status: "reused" }>,
  sourcePlan: ChannelPlanInput,
) {
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

function needsLabelImage(result: ReuseResult, manifest?: Manifest | null): manifest is Manifest {
  return result.status === "extract" && result.reason === LABEL_TEXT_UNAVAILABLE && !!manifest;
}

/** Reads the facts image by OCR and asks the reuse activity again with it; no label image means extraction. */
async function checkLabelImage(step: {
  input: ProductPipelineInput;
  pipeline: PipelineActivities;
  sourcePlan: ChannelPlanInput;
  request: SiblingReuseRequest;
  manifest: Manifest;
}): Promise<ReuseResult> {
  const labelImage = await labelImageSelection(step);
  if (!labelImage) {
    return { status: "extract", reason: pipelineErrors.code("FORMULA.LABEL_IMAGE_UNAVAILABLE") };
  }
  return SiblingReuseResultSchema.parse(
    await step.pipeline.reuseSiblingFormula({ ...step.request, labelImage }),
  );
}
