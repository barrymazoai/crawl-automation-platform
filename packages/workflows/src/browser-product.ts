import { pipelineErrors } from "@crawl-automation/platform/errors/activity";
import { versionedResourceGate } from "./resources/versioned-gate.js";
import { ApplicationFailure, patched, proxyActivities } from "@temporalio/workflow";
import {
  BrowserCaptureResultSchema,
  type BrowserActivities,
  type PipelineActivities,
  type ProductPipelineInput,
} from "./pipeline-model.js";
import { collectFamilyProduct } from "./family-product.js";
import { once } from "./activity-options.js";
import { collectCapturedProduct } from "./collect-captured-product.js";
import { browserRoute } from "./resources/browser-route.js";

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
  const route = browserRoute({
    resources: input.resources,
    activity: "captureProduct",
    queue,
    required: true,
  });
  const gate = versionedResourceGate(route.resources, { ignoreLegacyBinding: true });
  const captured = BrowserCaptureResultSchema.parse(
    await gate("captureProduct", (binding) =>
      proxyActivities<BrowserActivities>({
        taskQueue: route.queue,
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
  return collectFamilyProduct(input, pipeline, captured);
}
