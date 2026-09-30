import { resourceGate } from "@crawl-automation/v3-product/resource-workflow";
import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import {
  BrowserCaptureResultSchema,
  KnownFormulaSchema,
  type BrowserActivities,
  type PipelineActivities,
  type ProductPipelineInput,
} from "./pipeline-model.js";
import { once } from "./activity-options.js";

/**
 * A product whose page only a browser can read (Whole Foods): the page is read and archived on the browser
 * machine, then the formula comes from its formula family by listing (Whole Foods shares Amazon's ASINs). A product
 * with no formula in its family ends in a Review naming why, until Amazon's own product run supplies the formula.
 */
export async function collectInBrowser(
  input: ProductPipelineInput,
  pipeline: PipelineActivities,
): Promise<unknown> {
  const queue = input.queues.browser;
  if (!queue) {
    throw ApplicationFailure.nonRetryable(
      "No browser task queue",
      "PIPELINE.BROWSER_QUEUE_MISSING",
    );
  }
  const browser = proxyActivities<BrowserActivities>({ taskQueue: queue, ...once });
  const gate = resourceGate(input.resources);
  const captured = BrowserCaptureResultSchema.parse(
    await gate("captureProduct", () => browser.captureBrowserProduct(input)),
  );
  if (captured.status !== "captured") {
    return captured;
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
    code: "PIPELINE.FORMULA_PENDING",
    causeCode: "WHOLEFOODS.AMAZON_FORMULA_MISSING",
  });
}
