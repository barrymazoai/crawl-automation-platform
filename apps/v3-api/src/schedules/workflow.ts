import { ApplicationFailure, proxyActivities, workflowInfo } from "@temporalio/workflow";
import { ScheduleDefinition, ScheduleTick, type ScheduleTickResult } from "@crawl-automation/v3-contracts";

// A short intake Workflow, not the collection itself. Collection delivery remains
// owned by the existing durable runner. No provider calls or business auto-retry.
export async function ScheduledCollectionIntake(raw: ScheduleDefinition): Promise<ScheduleTickResult> {
  const definition = ScheduleDefinition.parse(raw);
  const { acceptScheduleTick } = proxyActivities<{
    acceptScheduleTick(tick: ScheduleTick): Promise<ScheduleTickResult>;
  }>({ taskQueue: definition.activityQueue, startToCloseTimeout: "20 seconds", retry: { maximumAttempts: 1 } });
  const info = workflowInfo();
  const by = info.searchAttributes.TemporalScheduledById?.[0];
  const at = info.searchAttributes.TemporalScheduledStartTime?.[0];
  // SDK search-attribute Dates can come from a different VM realm.
  const scheduledAt = at && typeof at === "object" && "toISOString" in at && typeof at.toISOString === "function" ? at.toISOString() : null;
  if (typeof by !== "string" || !scheduledAt) throw ApplicationFailure.nonRetryable("Missing Temporal Schedule metadata", "SCHEDULE_IDENTITY");
  const tick = ScheduleTick.parse({ definition, namespace: info.namespace, scheduleId: by, workflowId: info.workflowId, scheduledAt });
  const result = await acceptScheduleTick(tick);
  if (result.state === "REVIEW") throw ApplicationFailure.nonRetryable(`Schedule intake requires review: ${result.reason}; request ${result.requestId}`, "SCHEDULE_REVIEW");
  return result;
}
