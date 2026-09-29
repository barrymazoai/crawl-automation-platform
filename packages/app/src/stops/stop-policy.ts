import { differenceInMinutes } from "date-fns";

/** What Temporal shows about one workflow execution, enough to decide whether its work has stopped. */
export interface StopEvidence {
  workflowId: string;
  status: string;
  closedAt: Date | null;
  /** Activities Temporal still counts as scheduled or running for this execution. */
  pendingActivities: number;
}

/** After a close, give a worker this long to finish its own cleanup (for example closing a browser page). */
export const SETTLE_AFTER_MINUTES = 5;

export type StopVerdict = "stopped" | "running" | "not-proven";

/**
 * A permit may be released only when the work it covered has provably stopped: the workflow is closed, no
 * Activity of it is still pending, and it closed long enough ago for the worker to finish its own cleanup.
 * A workflow Temporal cannot find is not proof of anything.
 */
export function stopVerdict(evidence: StopEvidence | null, now: Date): StopVerdict {
  if (!evidence) {
    return "not-proven";
  }
  if (evidence.status === "RUNNING") {
    return "running";
  }
  const settled =
    evidence.closedAt && differenceInMinutes(now, evidence.closedAt) >= SETTLE_AFTER_MINUTES;
  return evidence.pendingActivities === 0 && settled ? "stopped" : "not-proven";
}
