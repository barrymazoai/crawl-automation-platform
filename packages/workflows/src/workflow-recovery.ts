import { log, workflowInfo } from "@temporalio/workflow";
import { pipelineErrors } from "@crawl-automation/platform/errors/activity";
import { failureCode } from "./failure-code.js";

/** Temporal forwards replay-safe workflow logs to the worker's configured logger. */
export function recordWorkflowRecovery(error: unknown, context: Record<string, unknown>): void {
  const code = failureCode(error) ?? pipelineErrors.code("PIPELINE.ACTIVITY_UNRESOLVED");
  log.warn("Operation failed; recovery continues", {
    ...context,
    runId: workflowInfo().runId,
    code,
    err: error,
  });
}
