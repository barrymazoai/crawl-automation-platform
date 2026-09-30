import { pipelineErrors } from "@crawl-automation/platform/errors/activity";
import { resourceGateCodes } from "@crawl-automation/platform/errors/resource-gate";
import { isCancellation, patched, proxyActivities } from "@temporalio/workflow";
import { failureCode } from "./failure-code.js";
import {
  ProductPipelineInputSchema,
  type PipelineActivities,
  type ProductPipelineInput,
} from "./pipeline-model.js";
import { once, withDownloadHeartbeat } from "./activity-options.js";
import { collectInBrowser } from "./browser-product.js";
import { collectCapturedProduct } from "./collect-captured-product.js";
import { captureProduct } from "./resources/capture-product.js";

/**
 * The shared product pipeline for every channel:
 * capture (archive, then parse) -> save metrics and plan -> formula once -> otherwise read the formula.
 * Any failure ends in a Review with its real cause.
 */
export async function ProductPipelineWorkflow(raw: unknown): Promise<unknown> {
  const input = ProductPipelineInputSchema.parse(raw);
  const pipeline = withDownloadHeartbeat(
    proxyActivities<PipelineActivities>({ taskQueue: input.queues.activities, ...once }),
    input.queues.activities,
  );
  try {
    // Keep the recorded route when old inputs have no capability, or when replay predates the marker.
    const browser =
      input.capture !== undefined && patched("capture-mode-v1")
        ? input.capture === "browser"
        : input.channel === "wholefoods";
    return await (browser ? collectInBrowser(input, pipeline) : collect(input, pipeline));
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    const causeCode = failureCode(error);
    return pipeline.reviewProduct({
      pipeline: input,
      code: pipelineErrors.code("PIPELINE.PRODUCT_UNRESOLVED"),
      causeCode,
      ...(patched("resource-gate-v1") && causeCode === resourceGateCodes.waitLimit
        ? { executionFact: "not_executed" as const }
        : {}),
    });
  }
}

async function collect(
  input: ProductPipelineInput,
  pipeline: PipelineActivities,
): Promise<unknown> {
  const captured = await captureProduct(input, pipeline);
  // A Review, or a listing the revisit found unlisted (recorded as a sighting with its reason, not a failure).
  if (captured.status !== "captured") {
    return captured;
  }
  return collectCapturedProduct(input, pipeline, captured);
}
