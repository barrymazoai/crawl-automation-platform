import {
  ChannelPlanOutcomeSchema,
  ChannelPlanInputSchema,
  EnrichmentRouteSchema,
  SharedEnrichmentOutcomeSchema,
  type EnrichmentRequest,
  type ChannelPlanInput,
} from "@crawl-automation/v3-contracts";
import {
  ChildWorkflowCancellationType,
  ParentClosePolicy,
  executeChild,
  isCancellation,
  patched,
  proxyActivities,
  workflowInfo,
} from "@temporalio/workflow";
import { z } from "zod";
import { versionedResourceGate } from "./resources/versioned-gate.js";
import { failureCode } from "./failure-code.js";
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
    return withEnrichmentSource(
      {
        status: "collected",
        reusedFormula: true,
        operationId: known.operationId,
        observation: sourcePlan.owner,
      },
      sourcePlan,
    );
  }
  const reused = await reuseSiblingFormula({ input, pipeline, captured, plan: outcome });
  if (reused) {
    return withEnrichmentSource(reused, sourcePlan);
  }
  if (outcome.status === "review") {
    return outcome;
  }
  const result = await streamLabel({ input, pipeline, sourcePlan, manifest: outcome.manifest });
  return withEnrichmentSource(result, sourcePlan);
}

/** The verified projection carries the selected product's title even before history projection repair. */
function withEnrichmentSource(result: unknown, sourcePlan: ChannelPlanInput) {
  const success = z
    .object({ status: z.literal("collected") })
    .passthrough()
    .safeParse(result);
  return success.success && patched("product-enrichment-v1")
    ? { ...success.data, enrichmentSource: sourcePlan }
    : result;
}

interface EnrichmentActivities {
  prepareProductEnrichment(): Promise<unknown>;
  enrichCollectedProduct(request: EnrichmentRequest): Promise<unknown>;
  reviewProductEnrichment(request: {
    input: EnrichmentRequest;
    code: string | null;
  }): Promise<unknown>;
}

/** A separate result on a successful collection, including own, sibling and channel-family reuse. */
export async function enrichCollectedResult(input: ProductPipelineInput, result: unknown) {
  const collected = z
    .object({
      status: z.enum(["collected", "formula-linked"]),
      operationId: z.string(),
      observation: z
        .object({ listingId: z.string(), variantId: z.string().nullable() })
        .passthrough()
        .optional(),
      listingId: z.string().optional(),
      enrichmentSource: ChannelPlanInputSchema.optional(),
    })
    .passthrough()
    .safeParse(result);
  if (!collected.success) {
    return result;
  }
  const { enrichmentSource, ...found } = collected.data;
  const listingId = found.observation?.listingId ?? found.listingId;
  const request: EnrichmentRequest = {
    channel: input.channel,
    collectionOperationId: found.operationId,
    captureOperationId: input.operationId,
    ...(listingId ? { listingId } : {}),
    ...(found.observation ? { variantId: found.observation.variantId } : {}),
    ...(enrichmentSource ? { sourcePlan: enrichmentSource } : {}),
  };
  const enrichment = await enrichmentChild(input, request);
  return { ...found, enrichment };
}

async function enrichmentChild(input: ProductPipelineInput, request: EnrichmentRequest) {
  try {
    return await executeChild("ProductEnrichmentWorkflow", {
      workflowId: `${workflowInfo().workflowId}-enrichment`,
      taskQueue: input.queues.activities,
      args: [{ request, activitiesQueue: input.queues.activities }],
      retry: { maximumAttempts: 1 },
      parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
    });
  } catch (error) {
    const activities = proxyActivities<EnrichmentActivities>({
      taskQueue: input.queues.activities,
      ...once,
    });
    return reviewEnrichmentFailure({ activities, request, error });
  }
}

/** Both pipeline and bounded API backfill use exactly this non-retrying, model-permitted path. */
export async function runProductEnrichment(request: EnrichmentRequest, activitiesQueue: string) {
  const activities = proxyActivities<EnrichmentActivities>({ taskQueue: activitiesQueue, ...once });
  try {
    const route = EnrichmentRouteSchema.parse(await activities.prepareProductEnrichment());
    const gate = versionedResourceGate(route.resources);
    const result = await gate("enrichCollectedProduct", (binding) => {
      const model = proxyActivities<EnrichmentActivities>({
        ...once,
        ...binding,
        taskQueue: route.queue,
        heartbeatTimeout: "30 seconds",
      });
      return model.enrichCollectedProduct(request);
    });
    return SharedEnrichmentOutcomeSchema.parse(result);
  } catch (error) {
    return reviewEnrichmentFailure({ activities, request, error });
  }
}

async function reviewEnrichmentFailure(parts: {
  activities: EnrichmentActivities;
  request: EnrichmentRequest;
  error: unknown;
}) {
  const { activities, request, error } = parts;
  if (isCancellation(error)) {
    throw error;
  }
  try {
    return await activities.reviewProductEnrichment({ input: request, code: failureCode(error) });
  } catch (reviewError) {
    if (isCancellation(reviewError)) {
      throw reviewError;
    }
    return {
      status: "review",
      recordingPending: true,
      code: failureCode(error),
      recordingCode: failureCode(reviewError),
    };
  }
}
