import { pipelineErrors } from "@crawl-automation/platform/errors/activity";
import { versionedResourceGate } from "./resources/versioned-gate.js";
import { ApplicationFailure, patched, proxyActivities } from "@temporalio/workflow";
import {
  BrowserCaptureResultSchema,
  KnownFormulaSchema,
  type BrowserActivities,
  type PipelineActivities,
  type ProductPipelineInput,
} from "./pipeline-model.js";
import { once } from "./activity-options.js";
import { collectCapturedProduct } from "./collect-captured-product.js";

/**
 * A browser capture with a plan enters the shared formula pipeline; otherwise it reuses a family formula.
 * The formula-request activity name and failure code remain the recorded legacy protocol.
 */
export async function collectInBrowser(
  input: ProductPipelineInput,
  pipeline: PipelineActivities,
): Promise<unknown> {
  const queue = input.queues.browser;
  if (!queue) {
    throw ApplicationFailure.nonRetryable(
      "No browser task queue",
      pipelineErrors.code("PIPELINE.BROWSER_QUEUE_MISSING"),
    );
  }
  const gate = versionedResourceGate(input.resources, { ignoreLegacyBinding: true });
  const captured = BrowserCaptureResultSchema.parse(
    await gate("captureProduct", (binding) =>
      proxyActivities<BrowserActivities>({
        taskQueue: queue,
        ...once,
        ...binding,
      }).captureBrowserProduct(input),
    ),
  );
  if (captured.status !== "captured") {
    return captured;
  }
  // Old browser results have no plan and keep their recorded formula-family command sequence.
  if (captured.planned && patched("browser-formula-plan-v1")) {
    return collectCapturedProduct(input, pipeline, captured.planned);
  }
  const { listingId, variantId } = captured;
  const request = { runId: input.runId, channel: input.channel, listingId, variantId };
  const known = KnownFormulaSchema.parse(await pipeline.findKnownFormula(request));
  if (known) {
    return { status: "collected", reusedFormula: true, operationId: known.operationId, listingId };
  }
  await pipeline.requestAmazonFormula({ brandId: input.brandId, listingId });
  return pipeline.reviewProduct({
    pipeline: input,
    code: pipelineErrors.code("PIPELINE.FORMULA_PENDING"),
    causeCode: pipelineErrors.code("WHOLEFOODS.AMAZON_FORMULA_MISSING"),
  });
}
