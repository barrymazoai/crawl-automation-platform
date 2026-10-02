import { z } from "zod";
import { DtcVariantHandoffSchema, type DtcVariantHandoff } from "@crawl-automation/v3-contracts";
import {
  executeChild,
  workflowInfo,
  isCancellation,
  proxyActivities,
  ParentClosePolicy,
  ChildWorkflowCancellationType,
} from "@temporalio/workflow";
import {
  ProductPipelineInputSchema,
  type ProductPipelineInput,
  type PipelineActivities,
} from "./pipeline-model.js";
import { collectCapturedProduct, enrichCollectedResult } from "./collect-captured-product.js";
import { once } from "./activity-options.js";
import { failureCode } from "./failure-code.js";
import { pipelineErrors } from "@crawl-automation/platform/errors/activity";

/** Browser capture has ended. Each website variant gets an isolated, non-retrying downstream run. */
export async function collectDtcVariants(
  input: ProductPipelineInput,
  pipeline: PipelineActivities,
  variants: DtcVariantHandoff[],
) {
  const results = [];
  for (const member of variants) {
    const variantInput = { ...input, operationId: member.operationId, url: member.variant.url };
    let result;
    try {
      result =
        member.status === "review"
          ? await variantReview(pipeline, variantInput, member.code)
          : await variantChild(variantInput, member);
    } catch (error) {
      if (isCancellation(error)) {
        throw error;
      }
      result = await variantReview(pipeline, variantInput, failureCode(error));
    }
    results.push({
      operationId: member.operationId,
      variant: member.variant,
      evidence: member.evidence,
      ...(member.status === "review" ? { reason: member.reason } : {}),
      result,
    });
  }
  const completed = results.filter((entry) => complete.safeParse(entry.result).success).length;
  return {
    status: completed === results.length ? "collected" : "review",
    ...(completed === results.length
      ? {}
      : { code: pipelineErrors.code("DTC.VARIANTS_INCOMPLETE") }),
    counts: { total: results.length, completed, review: results.length - completed },
    variants: results,
  };
}

function variantChild(input: ProductPipelineInput, member: DtcVariantHandoff) {
  return executeChild("DtcVariantWorkflow", {
    workflowId: `${workflowInfo().workflowId}-${member.operationId}`,
    taskQueue: input.queues.activities,
    args: [{ input, member }],
    retry: { maximumAttempts: 1 },
    parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
    cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
  });
}

const complete = z.object({
  status: z.literal("collected"),
  enrichment: z.object({ status: z.literal("registered") }),
});

/** Shared Label and enrichment steps; no capture activity and no browser permit. */
export async function DtcVariantWorkflow(raw: unknown) {
  const { input, member } = z
    .strictObject({ input: ProductPipelineInputSchema, member: DtcVariantHandoffSchema })
    .parse(raw);
  if (
    input.channel !== "dtc" ||
    member.status !== "ready" ||
    input.operationId !== member.operationId ||
    input.url !== member.variant.url ||
    member.planned.sourcePlan.owner.variantId !== member.variant.variantId
  ) {
    throw new Error("Invalid DTC variant handoff");
  }
  const pipeline = proxyActivities<PipelineActivities>({
    taskQueue: input.queues.activities,
    ...once,
  });
  try {
    return await enrichCollectedResult(
      input,
      await collectCapturedProduct(input, pipeline, member.planned),
    );
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    return variantReview(pipeline, input, failureCode(error));
  }
}

async function variantReview(
  pipeline: PipelineActivities,
  input: ProductPipelineInput,
  causeCode: string | null,
) {
  try {
    return await pipeline.reviewProduct({
      pipeline: input,
      code: pipelineErrors.code("PIPELINE.PRODUCT_UNRESOLVED"),
      causeCode,
    });
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    return {
      status: "review",
      code: causeCode,
      recordingPending: true,
      recordingCode: failureCode(error),
    };
  }
}
