import { isDeepStrictEqual } from "node:util";
import type { SavedEvidenceSource } from "@crawl-automation/v3-contracts";
import type { OrderedDiagnostics } from "./ordered-diagnostics.js";
import type { OrderedProgress, OrderedState } from "./ordered-model.js";
import type { DiagnosedOrderedEvidence } from "./ordered-source-outcome.js";

/** What an earlier round of this task verified, keyed by source. */
export interface PreviousVerdicts {
  covered: number;
  outcomes: Map<string, OrderedDiagnostics["outcomes"][number]>;
  diagnostics: Map<string, NonNullable<OrderedDiagnostics["sourceDiagnostics"]>[number]>;
}

/**
 * The previous record's verdicts, when it is this task's own record of a prefix of these states: same input and the
 * same states in the same order. Anything else (another task, a reordered walk, an old record without diagnostics)
 * yields nothing and every source is read again.
 */
export function previousVerdicts(
  previous: OrderedDiagnostics | null,
  request: OrderedProgress,
): PreviousVerdicts | null {
  if (!previous?.sourceDiagnostics || !isDeepStrictEqual(previous.request.input, request.input)) {
    return null;
  }
  const prefix = previous.request.states;
  const samePrefix =
    prefix.length <= request.states.length &&
    prefix.every((state, index) => isDeepStrictEqual(state, request.states[index]));
  if (!samePrefix) {
    return null;
  }
  return {
    covered: prefix.length,
    outcomes: new Map(previous.outcomes.map((outcome) => [outcome.sourceId, outcome])),
    diagnostics: new Map(previous.sourceDiagnostics.map((entry) => [entry.sourceId, entry])),
  };
}

const REUSABLE_REASONS = new Set(["keyword_screen_missed", "no_text"]);

/** An image already verified as unmatched or as a reviewed front panel never enters the label. */
function reusableImage(at: {
  source: SavedEvidenceSource;
  state: OrderedState;
  index: number;
  verified: PreviousVerdicts;
}) {
  const { source, state, index, verified } = at;
  if (source.kind !== "file-image" || index >= verified.covered) {
    return null;
  }
  const diagnostic = verified.diagnostics.get(source.id);
  const outcome = verified.outcomes.get(source.id);
  if (!diagnostic || !outcome) {
    return null;
  }
  return reusableUnmatched(state, diagnostic, outcome) || reusableReview(state, diagnostic, outcome)
    ? { diagnostic, outcome }
    : null;
}

function reusableUnmatched(
  state: OrderedState,
  diagnostic: NonNullable<OrderedDiagnostics["sourceDiagnostics"]>[number],
  outcome: OrderedDiagnostics["outcomes"][number],
) {
  return (
    state.status === "not_matched" &&
    state.reason === undefined &&
    outcome.status === "not_matched" &&
    REUSABLE_REASONS.has(diagnostic.reason)
  );
}

function reusableReview(
  state: OrderedState,
  diagnostic: NonNullable<OrderedDiagnostics["sourceDiagnostics"]>[number],
  outcome: OrderedDiagnostics["outcomes"][number],
) {
  return (
    state.status === "review" &&
    outcome.status === "review" &&
    !!outcome.code &&
    outcome.evidenceKeys.length > 0 &&
    diagnostic.reason === "model_no_label"
  );
}

/** Reuse an absent-label verdict from this exact task prefix, retaining the original Review code and key. */
export function reuseVerdict(
  evidence: DiagnosedOrderedEvidence,
  at: {
    source: SavedEvidenceSource;
    state: OrderedState;
    index: number;
    verified: PreviousVerdicts | null;
  },
): boolean {
  const previous = at.verified ? reusableImage({ ...at, verified: at.verified }) : null;
  if (!previous) {
    return false;
  }
  recordReusedOutcome(evidence, at.source.id, previous);
  copyDiagnostic(evidence, at.source.id, previous.diagnostic);
  return true;
}

function recordReusedOutcome(
  evidence: DiagnosedOrderedEvidence,
  sourceId: string,
  previous: NonNullable<ReturnType<typeof reusableImage>>,
) {
  const { diagnostic, outcome } = previous;
  if (diagnostic.reason === "model_no_label") {
    (evidence.reusedOutcomes ??= new Map()).set(sourceId, outcome);
  }
  evidence.reasons.push({
    progress: 1,
    failure: {
      sourceId,
      code:
        diagnostic.reason === "model_no_label"
          ? (outcome.code ?? "CHANNEL.LABEL_NO_SOURCE")
          : "CHANNEL.LABEL_NO_SOURCE",
      executionFact: "executed",
      ...(diagnostic.reason === "model_no_label" ? { evidenceKey: outcome.evidenceKeys[0] } : {}),
    },
  });
}

function copyDiagnostic(
  evidence: DiagnosedOrderedEvidence,
  sourceId: string,
  diagnostic: NonNullable<OrderedDiagnostics["sourceDiagnostics"]>[number],
) {
  const current = evidence.sourceDiagnostics?.find((entry) => entry.sourceId === sourceId);
  if (current) {
    current.reason = diagnostic.reason;
    if (diagnostic.detail) {
      current.detail = diagnostic.detail;
    }
    if (diagnostic.reason !== "model_no_label") {
      current.matchedKeywords = [];
    }
  }
}

export function unmatchedDiagnostic(
  evidence: DiagnosedOrderedEvidence,
  source: SavedEvidenceSource,
  reason: "no_text" | undefined,
) {
  const diagnostic = evidence.sourceDiagnostics?.find((entry) => entry.sourceId === source.id);
  if (!diagnostic || diagnostic.reason === "skipped") {
    return;
  }
  if (source.kind === "file-image") {
    // SavedSourceEvidence verifies the screen before returning not_matched. Its contract
    // guarantees zero matched keywords; an empty OCR document has its own explicit reason.
    diagnostic.reason = reason === "no_text" ? "no_text" : "keyword_screen_missed";
    diagnostic.matchedKeywords = [];
  } else {
    diagnostic.reason = reason ?? "source_not_matched";
  }
}
