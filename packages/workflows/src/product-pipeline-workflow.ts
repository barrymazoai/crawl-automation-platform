import { resourceGateCodes } from "@crawl-automation/platform/errors/resource-gate";
import { ChannelPlanOutcomeSchema } from "@crawl-automation/v3-contracts";
import { isCancellation, patched, proxyActivities } from "@temporalio/workflow";
import { failureCode } from "./failure-code.js";
import {
  KnownFormulaSchema,
  ProductPipelineInputSchema,
  type PipelineActivities,
  type PlanActivities,
  type ProductPipelineInput,
} from "./pipeline-model.js";
import { once, withDownloadHeartbeat } from "./activity-options.js";
import { collectInBrowser } from "./browser-product.js";
import { reuseSiblingFormula } from "./sibling-reuse.js";
import { streamLabel } from "./stream-label.js";
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
    // Pages only a browser can read have no formula planner: their formula comes from the formula family.
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
      code: "PIPELINE.PRODUCT_UNRESOLVED",
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
  const plan = proxyActivities<PlanActivities>({ taskQueue: input.queues.plan, ...once });
  const captured = await captureProduct(input, pipeline);
  // A Review, or a listing the revisit found unlisted (recorded as a sighting with its reason, not a failure).
  if (captured.status !== "captured") {
    return captured;
  }
  const { sourcePlan } = captured;
  // Planning also records the product's metrics, so it runs on every capture, known formula or not.
  const outcome = ChannelPlanOutcomeSchema.parse(await plan.prepareChannelProduct(sourcePlan));
  const { listingId, variantId } = sourcePlan.owner;
  const known = KnownFormulaSchema.parse(
    await pipeline.findKnownFormula({
      runId: input.runId,
      channel: input.channel,
      listingId,
      variantId,
    }),
  );
  if (known) {
    return {
      status: "collected",
      reusedFormula: true,
      operationId: known.operationId,
      observation: sourcePlan.owner,
    };
  }
  const reused = await reuseSiblingFormula({ input, pipeline, captured, plan: outcome });
  if (reused) {
    return reused;
  }
  if (outcome.status === "review") {
    return outcome;
  }
  return streamLabel({ input, pipeline, sourcePlan, manifest: outcome.manifest });
}
