import { resourceGate } from "@crawl-automation/v3-product/resource-workflow";
import { imageActivityOptions } from "@crawl-automation/v3-contracts";
import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type { LabelWorkflowInput, QueueKind } from "./label-model.js";
import type { LabelStream } from "./label-stream.js";

type Activity = (value: unknown) => Promise<unknown>;

/** Permit failures that mean a source never ran (waiting) or may still be running (quarantined). */
const WAITING = "RESOURCE.WAIT_LIMIT";
const QUARANTINED = new Set(["RESOURCE.OWNER_QUARANTINED", "RESOURCE.REVIEW_STOP_UNVERIFIED"]);

/** One Label workflow run: its task, how it calls activities, its file stream and the sources held up by permits. */
export interface LabelRun {
  entry: LabelWorkflowInput;
  stream: LabelStream;
  call(kind: QueueKind, name: string, value: unknown): Promise<unknown>;
  waiting: string[];
  quarantined: string[];
}

export function labelRun(entry: LabelWorkflowInput, stream: LabelStream): LabelRun {
  // Image-first tasks stop after the first complete label, so a Review must prove its execution stopped.
  const requireReviewStop = entry.input.evidencePolicy === "label-image-first/5";
  const gate = resourceGate(entry.resources, { requireReviewStop });
  const call = (kind: QueueKind, name: string, value: unknown) =>
    gate(name, (binding) => {
      // One attempt per activity: a failure is a Review, never an automatic retry of paid or model work.
      const options = { ...imageActivityOptions(entry.queues[kind]), ...binding };
      const activity = proxyActivities<Record<string, Activity>>(options)[name];
      if (!activity) {
        throw ApplicationFailure.nonRetryable("Unknown label activity", "LABEL.ACTIVITY_UNKNOWN");
      }
      return activity(value);
    });
  return { entry, stream, call, waiting: [], quarantined: [] };
}

/** A permit failure is re-thrown (the product cannot continue safely); anything else is only recorded. */
export function isAdmissionFailure(error: unknown): boolean {
  const type = error instanceof ApplicationFailure ? error.type : undefined;
  return type === WAITING || (type !== undefined && type !== null && QUARANTINED.has(type));
}

/** Notes a source held up by a permit so the product ends in a dependency Review naming it. */
export function notePermitFailure(run: LabelRun, sourceId: string, error: unknown): void {
  if (!(error instanceof ApplicationFailure)) {
    return;
  }
  if (error.type === WAITING) {
    run.waiting.push(sourceId);
  }
  if (error.type && QUARANTINED.has(error.type)) {
    run.quarantined.push(sourceId);
  }
}
