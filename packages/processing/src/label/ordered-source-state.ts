import { isLabelCoreVerdict } from "@crawl-automation/platform/errors/label-core";
import type { SavedEvidenceSource } from "@crawl-automation/v3-contracts";
import { labelFailure } from "./label-errors.js";
import type { OrderedEvidence, OrderedProgress, OrderedState } from "./ordered-model.js";

/** A durable parser verdict has no core output to re-read; unknown execution still stops. */
export function readSourceState(
  reading: { request: OrderedProgress; evidence: OrderedEvidence },
  at: { source: SavedEvidenceSource; state: OrderedState },
): boolean {
  const { source, state } = at;
  if (["unresolved", "rejected"].includes(state.status)) {
    reading.evidence.terminal = true;
    reading.evidence.reasons.push({
      progress: 0,
      failure: {
        sourceId: source.id,
        code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
        executionFact: "unknown",
      },
    });
    return true;
  }
  if (state.status !== "not_matched" || !state.reason) {
    return false;
  }
  if (
    source.kind !== "page" ||
    !reading.request.input.corePolicy ||
    !isLabelCoreVerdict(state.reason)
  ) {
    throw labelFailure("CHANNEL.LABEL_IDENTITY_CONFLICT");
  }
  reading.evidence.reasons.push({
    progress: 1,
    failure: { sourceId: source.id, code: state.reason, executionFact: "executed" },
  });
  return true;
}
