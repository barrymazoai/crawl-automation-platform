import { currentMeasurement, type Logger } from "@crawl-automation/platform";
import { Context } from "@temporalio/activity";
import { activityIdentity } from "./activity-identity.js";

/**
 * A logger for one activity call: every line carries the run ID, the product's operation ID, the workflow and
 * Temporal run IDs and the activity name, so one run's lines are found with one filter.
 */
export function activityLogger(log: Logger, activity: string, raw: unknown): Logger {
  const execution = Context.current().info.workflowExecution;
  return log.child({
    activity,
    ...activityIdentity(raw),
    ...currentMeasurement()?.identity,
    workflowId: execution?.workflowId ?? null,
    temporalRunId: execution?.runId ?? null,
    outcomeCode: "started",
    cacheHit: null,
    providerCall: false,
    durationMs: 0,
  });
}
