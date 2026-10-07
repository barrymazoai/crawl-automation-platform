import type { HeldPermit } from "../runs/run-model.js";
import type { PermitOwner } from "@crawl-automation/platform";
import { stopVerdict, type StopEvidence, type StopVerdict } from "./stop-policy.js";

export interface StopEvidenceReader {
  stopEvidence(workflowId: string, runId: string): Promise<StopEvidence | null>;
  /** False only when the closed owner's history proves the permit's gated work was never scheduled. */
  permitWorkScheduled?(owner: PermitOwner): Promise<boolean>;
}

export interface JudgedPermit {
  permit: HeldPermit;
  verdict: StopVerdict;
}

/** Judges each held permit by its owner's stop evidence, asking Temporal once per owner execution. */
export async function judgePermits(
  permits: HeldPermit[],
  reader: StopEvidenceReader,
  now: Date,
): Promise<JudgedPermit[]> {
  const evidenceByOwner = new Map<string, StopEvidence | null>();
  for (const permit of permits) {
    const owner = `${permit.workflowId}/${permit.runId}`;
    if (!evidenceByOwner.has(owner)) {
      const evidence = await reader.stopEvidence(permit.workflowId, permit.runId);
      evidenceByOwner.set(owner, evidence);
    }
  }
  return permits.map((permit) => {
    const evidence = evidenceByOwner.get(`${permit.workflowId}/${permit.runId}`);
    return {
      permit,
      verdict: stopVerdict(
        evidence
          ? {
              ...evidence,
              executionStopped: permit.cleanup?.state === "stopped",
            }
          : null,
        now,
      ),
    };
  });
}
