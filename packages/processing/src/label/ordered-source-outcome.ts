import {
  assessLabelCandidate,
  type LabelCandidate,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { labelValidationErrors } from "./validation-errors.js";
import { imageReviewWithoutLabel } from "../assembly/source-without-label.js";
import type { OrderedEvidence, OrderedState } from "./ordered-model.js";
import type { OrderedDiagnostics } from "./ordered-diagnostics.js";

type Record = OrderedEvidence["entries"][number]["record"];
type Reviewed = NonNullable<OrderedEvidence["failures"][number]["reviewed"]>["record"];

export interface SourceDiagnostic {
  sourceId: string;
  kind: "page" | "image" | "text";
  status: string;
  reason: string;
  detail?: string;
  matchedKeywords?: string[];
}

export interface DiagnosedOrderedEvidence extends OrderedEvidence {
  sourceDiagnostics?: SourceDiagnostic[];
  reusedOutcomes?: Map<string, OrderedDiagnostics["outcomes"][number]>;
}

/** Small Review payload: the full originals and model answers remain in retained evidence. */
export function noSourceSummary(evidence: DiagnosedOrderedEvidence) {
  const sources = evidence.sourceDiagnostics ?? [];
  return {
    total: sources.length,
    omitted: Math.max(0, sources.length - 20),
    sources: sources.slice(0, 20).map((source) => compactDiagnostic(source, evidence)),
  };
}

function compactDiagnostic(source: SourceDiagnostic, evidence: OrderedEvidence) {
  const candidate = diagnosticCandidate(source.sourceId, evidence);
  const noLabel = isNoLabelDiagnostic(source, candidate);
  const detail = noLabel ? (candidate?.issues[0]?.detail ?? source.detail) : source.detail;
  return {
    sourceId: source.sourceId.slice(0, 128),
    kind: source.kind,
    status: source.status.slice(0, 24),
    reason: noLabel ? "model_no_label" : source.reason.slice(0, 120),
    ...(detail ? { detail: detail.slice(0, 240) } : {}),
    ...(source.matchedKeywords
      ? { matchedKeywords: source.matchedKeywords.slice(0, 6).map((word) => word.slice(0, 48)) }
      : {}),
  };
}

function isNoLabelDiagnostic(source: SourceDiagnostic, candidate: LabelImageCandidate | undefined) {
  if (source.reason === "model_no_label") {
    return true;
  }
  return (
    source.kind === "image" &&
    !!candidate &&
    imageReviewWithoutLabel({ id: source.sourceId, code: "", candidate, verifiedExecuted: true })
  );
}

function diagnosticCandidate(sourceId: string, evidence: OrderedEvidence) {
  const entry = evidence.entries.find((item) => item.id === sourceId);
  return entry?.kind === "image"
    ? entry.candidate
    : evidence.failures.find((failure) => failure.id === sourceId)?.candidate;
}

/** One source's own assessment; product conflicts are reported separately. */
export function sourceOutcome(state: OrderedState, evidence: DiagnosedOrderedEvidence) {
  const reused = evidence.reusedOutcomes?.get(state.id);
  if (reused) {
    return { ...reused, sections: [], executionFact: "executed", progress: 2 };
  }
  return freshOutcome(state, evidence);
}

function freshOutcome(state: OrderedState, evidence: OrderedEvidence) {
  const entry = evidence.entries.find((entry) => entry.id === state.id);
  const failure = evidence.failures.find((failure) => failure.id === state.id);
  const candidate = entry?.candidate ?? failure?.candidate;
  const reason = evidence.reasons.find((reason) => reason.failure.sourceId === state.id)?.failure;
  const assessed = candidateOutcome(candidate);
  const codes = [...new Set([...(reason ? [reason.code] : []), ...assessed.codes])];
  return {
    sourceId: state.id,
    status: state.status,
    code: codes[0] ?? null,
    codes,
    missing: assessed.missing,
    sections: assessed.sections,
    evidenceKeys: outcomeKeys({ entry, failure, reason }),
    executionFact: reason?.executionFact ?? "executed",
    progress: assessed.progress,
  };
}

function outcomeKeys(at: {
  entry: OrderedEvidence["entries"][number] | undefined;
  failure: OrderedEvidence["failures"][number] | undefined;
  reason: OrderedEvidence["reasons"][number]["failure"] | undefined;
}) {
  return sourceKeys(at.entry?.record ?? at.failure?.reviewed?.record, at.reason?.evidenceKey);
}

function candidateOutcome(candidate: LabelCandidate | undefined) {
  if (!candidate) {
    return { codes: [], missing: [], sections: [], progress: 1 };
  }
  const missing = [
    ...(!candidate.formulaComplete ? [labelValidationErrors.code("LABEL.FORMULA_INCOMPLETE")] : []),
    ...(!candidate.ingredientsComplete
      ? [labelValidationErrors.code("LABEL.INGREDIENTS_INCOMPLETE")]
      : []),
  ];
  return {
    missing,
    codes: [...assessLabelCandidate(candidate).codes, ...missing],
    sections: [
      ...(candidate.formula ? ["formula"] : []),
      ...(candidate.otherIngredients ? ["ingredients"] : []),
    ],
    progress: candidate.formula ? 4 : candidate.otherIngredients ? 3 : 2,
  };
}

function sourceKeys(record: Record | Reviewed | undefined, reviewKey: string | undefined) {
  const keys = record
    ? [record.result.objectKey, ...("completion" in record ? [record.completion.objectKey] : [])]
    : [];
  if (reviewKey && !keys.includes(reviewKey)) {
    keys.push(reviewKey);
  }
  return keys;
}
