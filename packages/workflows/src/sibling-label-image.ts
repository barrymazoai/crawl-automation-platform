import { FileAcquireOutcomeSchema, type ChannelPlanInput } from "@crawl-automation/v3-contracts";
import { ocrImage } from "./label/label-image-ocr.js";
import type { Manifest } from "./label/label-model.js";
import { labelRun } from "./label/label-run.js";
import type { LabelStream } from "./label/label-stream.js";
import type { PipelineActivities, ProductPipelineInput } from "./pipeline-model.js";

/** Each image is downloaded here before it is read, so it is always ready; nothing is streamed. */
const DOWNLOADED: LabelStream = {
  ready: async () => true,
  finish: async () => true,
};

/**
 * The facts image of a product whose page prints no facts text: its label images are downloaded and read in page
 * order with the Label workflow's own OCR and keyword steps (same operations, permits and single attempts), and the
 * first image whose OCR text shows label keywords is returned as its keyword selection. The Label workflow reuses
 * the same downloads and OCR results if the formula still has to be read. Null when no image shows a label.
 */
export async function labelImageSelection(step: {
  input: ProductPipelineInput;
  pipeline: PipelineActivities;
  sourcePlan: ChannelPlanInput;
  manifest: Manifest;
}): Promise<unknown> {
  const { input, pipeline, sourcePlan } = step;
  const task = await pipeline.prepareLabelTask({ pipeline: input, sourcePlan });
  const run = labelRun(task, DOWNLOADED);
  for (const source of step.manifest.sources) {
    if (source.kind !== "file-image") {
      continue;
    }
    const acquire = source.plan.acquire;
    const receipt = FileAcquireOutcomeSchema.parse(
      await pipeline.acquireProductFile({ pipeline: input, sourcePlan, acquire }),
    );
    if (receipt.status === "review" || receipt.operationId !== acquire.operationId) {
      return null;
    }
    const outcome = await ocrImage(run, source);
    if (outcome.kind === "selection" && isLabel(outcome.selection)) {
      return outcome.selection;
    }
  }
  return null;
}

/** The OCR step already checked the selection against its receipt; only a keyword match is a facts image. */
function isLabel(selection: unknown): boolean {
  return (selection as { status?: unknown }).status === "matched";
}
