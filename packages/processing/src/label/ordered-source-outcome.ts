import { assessLabelCandidate, type LabelCandidate } from "@crawl-automation/v3-contracts";
import { labelValidationErrors } from "./validation-errors.js";
import type { OrderedEvidence, OrderedState } from "./ordered-model.js";

type Record = OrderedEvidence["entries"][number]["record"];
type Reviewed = NonNullable<OrderedEvidence["failures"][number]["reviewed"]>["record"];

/** One source's own assessment; product conflicts are reported separately. */
export function sourceOutcome(state: OrderedState, evidence: OrderedEvidence) {
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
