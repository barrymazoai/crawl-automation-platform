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

/** An image the previous round verified as matching no keyword; it never enters the label. */
function reusableImage(at: {
  source: SavedEvidenceSource;
  state: OrderedState;
  index: number;
  verified: PreviousVerdicts;
}) {
  const { source, state, index, verified } = at;
  const unmatchedImage =
    source.kind === "file-image" && state.status === "not_matched" && state.reason === undefined;
  if (!unmatchedImage || index >= verified.covered) {
    return null;
  }
  const diagnostic = verified.diagnostics.get(source.id);
  const verdict = verified.outcomes.get(source.id)?.status === "not_matched";
  return verdict && diagnostic && REUSABLE_REASONS.has(diagnostic.reason) ? diagnostic : null;
}

/** Owner 2026-10-21: reuse the verified "no keyword" verdict instead of re-reading the image and its OCR record. */
export function reuseVerdict(
  evidence: DiagnosedOrderedEvidence,
  at: {
    source: SavedEvidenceSource;
    state: OrderedState;
    index: number;
    verified: PreviousVerdicts | null;
  },
): boolean {
  const diagnostic = at.verified ? reusableImage({ ...at, verified: at.verified }) : null;
  if (!diagnostic) {
    return false;
  }
  evidence.reasons.push({
    progress: 1,
    failure: {
      sourceId: at.source.id,
      code: "CHANNEL.LABEL_NO_SOURCE",
      executionFact: "executed",
    },
  });
  const current = evidence.sourceDiagnostics?.find((entry) => entry.sourceId === at.source.id);
  if (current) {
    current.reason = diagnostic.reason;
    current.matchedKeywords = [];
  }
  return true;
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
