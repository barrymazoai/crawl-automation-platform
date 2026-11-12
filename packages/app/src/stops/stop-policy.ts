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

/**
 * Temporal namespace crawler-v3 keeps a closed run for 7 days, then deletes it; it never deletes a run still running.
 * KAN-243 (2026-11-12): permits whose owner closed before that window held their resources for weeks (the Whole Foods
 * brand-scan permit from 10-16 blocked 1,205 brand scans), because "not found" proved nothing. Change this with the
 * namespace's retention.
 */
export const OWNER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const PURGED_OWNER_STATUS = "PURGED";

/**
 * The stop evidence of an owner Temporal no longer finds: closed, since its permit was granted longer ago than the
 * retention. Null while the permit is younger (a missing run then still proves nothing).
 */
export function purgedOwnerEvidence(
  owner: { workflowId: string; grantedAt?: string },
  now: Date,
): StopEvidence | null {
  const granted = owner.grantedAt ? Date.parse(owner.grantedAt) : Number.NaN;
  if (!Number.isFinite(granted) || now.getTime() - granted <= OWNER_RETENTION_MS) {
    return null;
  }
  return {
    workflowId: owner.workflowId,
    status: PURGED_OWNER_STATUS,
    closedAt: new Date(granted),
    pendingActivities: 0,
  };
}
