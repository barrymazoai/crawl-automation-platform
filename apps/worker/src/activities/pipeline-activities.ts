import {
  AmazonFormulaRequestSchema,
  FileRequestSchema,
  FormulaRequestSchema,
  LabelHandoffRequestSchema,
  ProductPipelineInputSchema,
  ProductPlanRequestSchema,
  ReviewRequestSchema,
} from "@crawl-automation/workflows";
import { Context } from "@temporalio/activity";
import type { WorkerParts } from "../container.js";
import { workerErrors } from "../errors.js";
import { guarded } from "./activity-guard.js";

/** The workflow run that called this activity, for the observation's execution record. */
function callingExecution(parts: WorkerParts) {
  const execution = Context.current().info.workflowExecution;
  if (!execution) {
    throw workerErrors.create("WORKER.WORKFLOW_REQUIRED");
  }
  return {
    clusterId: parts.config.clusterId,
    namespace: parts.config.temporal.namespace,
    workflowId: execution.workflowId,
    runId: execution.runId,
  };
}

function prepareProductPlan(parts: WorkerParts, raw: unknown, signal: AbortSignal) {
  const { sourceUrl, ...input } = ProductPlanRequestSchema.parse(raw);
  const plans = sourceUrl
    ? parts.channelPlans.forBrandSource(input.channel, sourceUrl)
    : parts.channelPlans;
  return plans.run(input, signal);
}

/**
 * The pipeline's activities. Each checks its input against the shared schema and calls one service;
 * no business rule lives here.
 */
export function pipelineActivities(parts: WorkerParts) {
  const handlers = {
    captureProduct: (raw: unknown, signal: AbortSignal) =>
      parts.pipelineCapture.capture(ProductPipelineInputSchema.parse(raw), signal),
    findKnownFormula: (raw: unknown) => {
      const { runId: _runId, ...key } = FormulaRequestSchema.parse(raw);
      return parts.formulaLookup.findKnown(key);
    },
    reuseSiblingFormula: (raw: unknown, signal: AbortSignal) =>
      parts.siblingReuse.reuse(raw, signal),
    prepareLabelHandoff: (raw: unknown, signal: AbortSignal) => {
      const request = LabelHandoffRequestSchema.parse(raw);
      return parts.labelHandoffs.prepare(
        { ...request, execution: callingExecution(parts) },
        signal,
      );
    },
    prepareLabelTask: (raw: unknown, signal: AbortSignal) => {
      const request = LabelHandoffRequestSchema.parse(raw);
      return parts.labelTasks.prepare({ ...request, execution: callingExecution(parts) }, signal);
    },
    // The formula planner: saves the plan of the product's formula sources (queue `plan` of the pipeline input).
    prepareChannelProduct: (raw: unknown, signal: AbortSignal) =>
      prepareProductPlan(parts, raw, signal),
    acquireProductFile: (raw: unknown, signal: AbortSignal) => {
      const { pipeline, sourcePlan, acquire } = FileRequestSchema.parse(raw);
      return parts.productFiles.acquire({ channel: pipeline.channel, sourcePlan, acquire }, signal);
    },
    reviewProduct: (raw: unknown, signal: AbortSignal) =>
      parts.productReviews.review(ReviewRequestSchema.parse(raw), signal),
    requestAmazonFormula: (raw: unknown) => {
      const { brandId, listingId, ...outcome } = AmazonFormulaRequestSchema.parse(raw);
      return parts.amazonFormulaRequests.request({ brandId, asin: listingId, ...outcome });
    },
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [name, guarded(name, handler, parts.log)]),
  );
}
