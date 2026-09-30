import { ChannelPlanOutcomeSchema } from "@crawl-automation/v3-contracts";
import { proxyActivities } from "@temporalio/workflow";
import { once } from "./activity-options.js";
import {
  KnownFormulaSchema,
  type CaptureResult,
  type PipelineActivities,
  type PlanActivities,
  type ProductPipelineInput,
} from "./pipeline-model.js";
import { reuseSiblingFormula } from "./sibling-reuse.js";
import { streamLabel } from "./stream-label.js";

/** The same formula planning, reuse and Label steps follow HTTP and browser captures. */
export async function collectCapturedProduct(
  input: ProductPipelineInput,
  pipeline: PipelineActivities,
  captured: Extract<CaptureResult, { status: "captured" }>,
): Promise<unknown> {
  const plan = proxyActivities<PlanActivities>({ taskQueue: input.queues.plan, ...once });
  const { sourcePlan } = captured;
  // Plan the retained page on every capture, known formula or not; capture already records metrics.
  // Old strict workflow inputs could not contain sourceUrl: their command payload stays identical.
  const request = input.sourceUrl ? { ...sourcePlan, sourceUrl: input.sourceUrl } : sourcePlan;
  const outcome = ChannelPlanOutcomeSchema.parse(await plan.prepareChannelProduct(request));
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
