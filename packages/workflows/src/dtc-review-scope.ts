import {
  DtcScopeExcludedSchema,
  NotSupplementSchema,
  ResourceGateSchema,
  type ChannelPlanInput,
} from "@crawl-automation/v3-contracts";
import { isCancellation, patched, proxyActivities } from "@temporalio/workflow";
import { z } from "zod";
import { once } from "./activity-options.js";
import type { ProductPipelineInput } from "./pipeline-model.js";
import { versionedResourceGate } from "./resources/versioned-gate.js";

interface ReviewScopeActivities {
  prepareDtcReviewScope(): Promise<unknown>;
  reviewDtcProductScope(request: {
    sourcePlan: ChannelPlanInput;
    operationId: string;
    reviewCode: string | null;
  }): Promise<unknown>;
}

const Review = z
  .object({
    status: z.literal("review"),
    code: z.string().optional(),
    codes: z.array(z.string()).optional(),
  })
  .passthrough();
const Route = z.strictObject({ queue: z.string().min(1).max(200), resources: ResourceGateSchema });
const Excluded = z.union([DtcScopeExcludedSchema, NotSupplementSchema]);

/**
 * Owner 2026-10-30: a DTC Review asks once whether the offer is a supplement, a bundle or neither, under the label
 * text model's permit. A bundle or a product outside supplements finishes without a formula; anything else, including
 * a failed or unresolved answer, keeps the original Review. Only new histories (marker).
 */
export async function dtcReviewScope(
  input: ProductPipelineInput,
  sourcePlan: ChannelPlanInput,
  result: unknown,
) {
  const review = Review.safeParse(result);
  if (input.channel !== "dtc" || !review.success || !patched("dtc-review-scope-v1")) {
    return null;
  }
  const activities = proxyActivities<ReviewScopeActivities>({
    taskQueue: input.queues.activities,
    ...once,
  });
  try {
    const route = Route.parse(await activities.prepareDtcReviewScope());
    const gate = versionedResourceGate(route.resources);
    const outcome = await gate("reviewDtcProductScope", (binding) =>
      proxyActivities<ReviewScopeActivities>({
        ...once,
        ...binding,
        taskQueue: route.queue,
        heartbeatTimeout: "30 seconds",
      }).reviewDtcProductScope({
        sourcePlan,
        operationId: input.operationId,
        reviewCode: review.data.code ?? review.data.codes?.[0] ?? null,
      }),
    );
    const excluded = Excluded.safeParse(outcome);
    return excluded.success ? excluded.data : null;
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    return null;
  }
}
