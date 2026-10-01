import { pipelineErrors } from "@crawl-automation/platform/errors/activity";
import { resourceGateCodes } from "@crawl-automation/platform/errors/resource-gate";
import { isCancellation, patched, proxyActivities } from "@temporalio/workflow";
import { legacyBrowserCapture } from "./legacy-capture.js";
import { collectFamilyProduct } from "./family-product.js";
import { failureCode } from "./failure-code.js";
import {
  ProductPipelineInputSchema,
  type PipelineActivities,
  type ProductPipelineInput,
} from "./pipeline-model.js";
import { once, withDownloadHeartbeat } from "./activity-options.js";
import { collectInBrowser } from "./browser-product.js";
import {
  collectCapturedProduct,
  enrichCollectedResult,
  runProductEnrichment,
} from "./collect-captured-product.js";
import { EnrichmentWorkflowInputSchema } from "@crawl-automation/v3-contracts";
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
    // New work receives adapter captureModes; absent capabilities default to HTTP.
    // Histories without the marker retain their recorded commands.
    const browser = patched("capture-mode-v1")
      ? input.capture === "browser"
      : legacyBrowserCapture(input.channel);
    const result = await (browser ? collectInBrowser(input, pipeline) : collect(input, pipeline));
    return patched("product-enrichment-v1") ? await enrichCollectedResult(input, result) : result;
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    const causeCode = failureCode(error);
    if (causeCode === "CAPTURE.IN_FLIGHT" && patched("capture-follower-v1")) {
      return { status: "pending", code: causeCode, operationId: input.operationId };
    }
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

/** Manually started from the bounded enrichment API; no product capture or formula extraction. */
export async function ProductEnrichmentWorkflow(raw: unknown): Promise<unknown> {
  const input = EnrichmentWorkflowInputSchema.parse(raw);
  return runProductEnrichment(input.request, input.activitiesQueue);
}

async function collect(
  input: ProductPipelineInput,
  pipeline: PipelineActivities,
): Promise<unknown> {
  const captured = await captureProduct(input, pipeline);
  if (captured.status === "captured-family" && patched("formula-family-capture-v1")) {
    return collectFamilyProduct(input, pipeline, captured);
  }
  // A Review, or a listing the revisit found unlisted (recorded as a sighting with its reason, not a failure).
  if (captured.status !== "captured") {
    return captured;
  }
  return collectCapturedProduct(input, pipeline, captured);
}
