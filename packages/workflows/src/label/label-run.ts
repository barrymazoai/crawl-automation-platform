import { versionedResourceGate } from "../resources/versioned-gate.js";
import { resourceGateCodes } from "@crawl-automation/platform/errors/resource-gate";
import { activityCodes } from "@crawl-automation/platform/errors/activity";
import { ApplicationFailure, patched, proxyActivities } from "@temporalio/workflow";
import { labelActivityOptions } from "./label-activity-options.js";
import { isHeartbeatFailure, withHeartbeatFailure } from "./activity-heartbeat.js";
import type { LabelWorkflowInput, QueueKind } from "./label-model.js";
import type { LabelStream } from "./label-stream.js";

type Activity = (value: unknown) => Promise<unknown>;

/** Permit failures that mean a source never ran (waiting) or may still be running (quarantined). */
const WAITING = resourceGateCodes.waitLimit;
const QUARANTINED = new Set<string>([
  resourceGateCodes.ownerQuarantined,
  resourceGateCodes.reviewStopUnverified,
]);

/** One Label workflow run: its task, how it calls activities, its file stream and the sources held up by permits. */
export interface LabelRun {
  entry: LabelWorkflowInput;
  stream: LabelStream;
  call(kind: QueueKind, name: string, value: unknown): Promise<unknown>;
  waiting: string[];
  quarantined: string[];
  heartbeatFailures: { sourceId: string; code: string; executionFact: "unknown" }[];
}

export function labelRun(entry: LabelWorkflowInput, stream: LabelStream): LabelRun {
  const gate = versionedResourceGate(entry.resources);
  const call = (kind: QueueKind, name: string, value: unknown) =>
    gate(name, (binding) => {
      // The lazy legacy gate must emit its existing markers before this new activity option patch.
      const heartbeats = patched("label-heartbeat-v1");
      // One attempt per activity: a failure is a Review, never an automatic retry of paid or model work.
      const options = { ...labelActivityOptions(entry.queues[kind], heartbeats), ...binding };
      const activity = proxyActivities<Record<string, Activity>>(options)[name];
      if (!activity) {
        throw ApplicationFailure.nonRetryable("Unknown label activity", "LABEL.ACTIVITY_UNKNOWN");
      }
      // A failed Review write must escape, never cause another Review write from the outer catch.
      return heartbeats && name !== "reviewLabelProduct"
        ? withHeartbeatFailure(() => activity(value))
        : activity(value);
    });
  return { entry, stream, call, waiting: [], quarantined: [], heartbeatFailures: [] };
}

/** A permit failure is re-thrown (the product cannot continue safely); anything else is only recorded. */
export function isAdmissionFailure(error: unknown): boolean {
  const type = error instanceof ApplicationFailure ? error.type : undefined;
  return type === WAITING || (type !== undefined && type !== null && QUARANTINED.has(type));
}

/** Records permit and heartbeat failures with the affected source for the product Review. */
export function noteSourceFailure(run: LabelRun, sourceId: string, error: unknown): void {
  if (!(error instanceof ApplicationFailure)) {
    return;
  }
  if (error.type === WAITING) {
    run.waiting.push(sourceId);
  }
  if (error.type && QUARANTINED.has(error.type)) {
    run.quarantined.push(sourceId);
  }
  if (isHeartbeatFailure(error)) {
    run.heartbeatFailures.push({
      sourceId,
      code: activityCodes.heartbeatTimeout,
      executionFact: "unknown",
    });
  }
}
