import {
  FileRequestSchema,
  FormulaRequestSchema,
  LabelHandoffRequestSchema,
  ProductPipelineInputSchema,
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
    reuseSiblingFormula: (raw: unknown) => parts.siblingReuse.reuse(raw),
    prepareLabelHandoff: (raw: unknown, signal: AbortSignal) => {
      const request = LabelHandoffRequestSchema.parse(raw);
      return parts.labelHandoffs.prepare(
        { ...request, execution: callingExecution(parts) },
        signal,
      );
    },
    acquireProductFile: (raw: unknown, signal: AbortSignal) => {
      const { pipeline, sourcePlan, acquire } = FileRequestSchema.parse(raw);
      return parts.productFiles.acquire({ channel: pipeline.channel, sourcePlan, acquire }, signal);
    },
    reviewProduct: (raw: unknown, signal: AbortSignal) =>
      parts.productReviews.review(ReviewRequestSchema.parse(raw), signal),
  };
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [name, guarded(name, handler, parts.log)]),
  );
}
