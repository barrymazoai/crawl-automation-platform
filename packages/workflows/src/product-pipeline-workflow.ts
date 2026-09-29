import { resourceGate } from "@crawl-automation/v3-product/resource-workflow";
import { ChannelPlanOutcomeSchema } from "@crawl-automation/v3-contracts";
import { isCancellation, proxyActivities } from "@temporalio/workflow";
import { failureCode } from "./failure-code.js";
import {
  CaptureResultSchema,
  KnownFormulaSchema,
  ProductPipelineInputSchema,
  type PipelineActivities,
  type PlanActivities,
  type ProductPipelineInput,
} from "./pipeline-model.js";
import { reuseSiblingFormula } from "./sibling-reuse.js";
import { streamLabel } from "./stream-label.js";

/** One attempt per Activity: a failure becomes a Review, never an automatic retry of paid or model work. */
const once = {
  startToCloseTimeout: "10 minutes",
  scheduleToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 1 },
} as const;

/**
 * The shared product pipeline for every channel:
 * capture (archive, then parse) -> save metrics and plan -> formula once -> otherwise read the formula.
 * Any failure ends in a Review with its real cause.
 */
export async function ProductPipelineWorkflow(raw: unknown): Promise<unknown> {
  const input = ProductPipelineInputSchema.parse(raw);
  const pipeline = proxyActivities<PipelineActivities>({
    taskQueue: input.queues.activities,
    ...once,
  });
  try {
    return await collect(input, pipeline);
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    const causeCode = failureCode(error);
    return pipeline.reviewProduct({
      pipeline: input,
      code: "PIPELINE.PRODUCT_UNRESOLVED",
      causeCode,
    });
  }
}

async function collect(
  input: ProductPipelineInput,
  pipeline: PipelineActivities,
): Promise<unknown> {
  const plan = proxyActivities<PlanActivities>({ taskQueue: input.queues.plan, ...once });
  const gate = resourceGate(input.resources);
  const captured = CaptureResultSchema.parse(
    await gate("captureProduct", () => pipeline.captureProduct(input)),
  );
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
  const reused = await reuseSiblingFormula({ input, pipeline, captured });
  if (reused) {
    return reused;
  }
  if (outcome.status === "review") {
    return outcome;
  }
  return streamLabel({ input, pipeline, sourcePlan, manifest: outcome.manifest });
}
