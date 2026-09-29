import type { HeldPermit } from "../runs/run-model.js";
import { stopVerdict, type StopEvidence, type StopVerdict } from "./stop-policy.js";

export interface StopEvidenceReader {
  stopEvidence(workflowId: string, runId: string): Promise<StopEvidence | null>;
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
  const verdicts = new Map<string, StopVerdict>();
  for (const permit of permits) {
    const owner = `${permit.workflowId}/${permit.runId}`;
    if (!verdicts.has(owner)) {
      const evidence = await reader.stopEvidence(permit.workflowId, permit.runId);
      verdicts.set(owner, stopVerdict(evidence, now));
    }
  }
  return permits.map((permit) => ({
    permit,
    verdict: verdicts.get(`${permit.workflowId}/${permit.runId}`) ?? "not-proven",
  }));
}
