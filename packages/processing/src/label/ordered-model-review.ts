import { imageReviewWithoutLabel } from "../assembly/source-without-label.js";
import { recordPartialSection } from "./ordered-source-state.js";
import type { DiagnosedOrderedEvidence } from "./ordered-source-outcome.js";

type Failure = DiagnosedOrderedEvidence["failures"][number];

/** A missing or conflicting evidence identity is never a content-based reason to skip a source. */
export function blocksFallback(code: string, executionFact: string) {
  return (
    executionFact === "unknown" ||
    /(?:IDENTITY|CONFLICT|MISMATCH|UNVERIFIED|UNKNOWN|PENDING|NOT_DURABLE|UNCONFIRMED)/.test(code)
  );
}

export function recordModelReview(
  evidence: DiagnosedOrderedEvidence,
  failure: Failure,
  sourceId: string,
) {
  evidence.failures.push(failure);
  evidence.terminal ||= !failure.verifiedExecuted || blocksFallback(failure.code, "executed");
  diagnoseNoLabel(evidence, failure, sourceId);
  recordPartialSection(evidence, sourceId, failure.candidate);
  evidence.reasons.push({
    progress: failure.candidate?.formula || failure.hasFormula ? 4 : 3,
    failure: {
      sourceId,
      code: failure.code,
      executionFact: failure.verifiedExecuted ? "executed" : "unknown",
      evidenceKey: failure.evidenceKey,
    },
  });
}

function diagnoseNoLabel(evidence: DiagnosedOrderedEvidence, failure: Failure, sourceId: string) {
  if (!imageReviewWithoutLabel(failure)) {
    return;
  }
  const diagnostic = evidence.sourceDiagnostics?.find((item) => item.sourceId === sourceId);
  if (diagnostic) {
    diagnostic.reason = "model_no_label";
    const detail = failure.candidate?.issues[0]?.detail;
    if (detail) {
      diagnostic.detail = detail;
    }
  }
}
