/** What Temporal shows about one workflow execution, enough to decide whether its work has stopped. */
export interface StopEvidence {
  workflowId: string;
  status: string;
  closedAt: Date | null;
  /** Activities Temporal still counts as scheduled or running for this execution. */
  pendingActivities: number;
  /** Exact permit's journal proves every executor/page stopped; Temporal status is not this proof. */
  executionStopped?: boolean;
}

export type StopVerdict = "stopped" | "running" | "not-proven";

/**
 * A permit may be released only when the work it covered has provably stopped: the workflow is closed, no
 * Activity of it is still pending, and its executor journal proves that actual execution ended.
 * A workflow Temporal cannot find is not proof of anything.
 */
export function stopVerdict(evidence: StopEvidence | null, now: Date): StopVerdict {
  if (!evidence) {
    return "not-proven";
  }
  if (evidence.status === "RUNNING") {
    return "running";
  }
  return evidence.pendingActivities === 0 &&
    evidence.closedAt &&
    evidence.closedAt <= now &&
    evidence.executionStopped === true
    ? "stopped"
    : "not-proven";
}
