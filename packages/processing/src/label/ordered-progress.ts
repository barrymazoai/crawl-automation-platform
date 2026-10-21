import { formulaConflictDetails, ingredientConflictDetails } from "@crawl-automation/v3-contracts";
import {
  mergeLabelProduct,
  type MergeFailure,
  type VerifiedLabelSource,
} from "../assembly/label-merge.js";
import { assemblyErrors } from "../assembly/assembly-errors.js";
import { imageReviewWithoutLabel } from "../assembly/source-without-label.js";
import {
  progressCompletion,
  progressReport,
  resolvedPartialFailure,
} from "./ordered-progress-parts.js";
import {
  noSourceSummary,
  sourceOutcome,
  type DiagnosedOrderedEvidence,
} from "./ordered-source-outcome.js";
import type { OrderedProgress, SourceFailure } from "./ordered-model.js";

export type OrderedFailurePolicy = NonNullable<OrderedProgress["input"]["failurePolicy"]>;

/**
 * Completeness and conflicts come from the same merger used by assembly and collection. A one-part label without a
 * formula (ingredients only, collected-product/5) completes only once no source is left untried, so a Facts photo
 * after an ingredients-only page still supplies the formula (owner 2026-10-07).
 */
export function orderedProgress(
  request: OrderedProgress,
  evidence: DiagnosedOrderedEvidence,
  untried = 0,
) {
  const { withoutLabel, eligible, merged } = mergeProgressEvidence(request, evidence);
  const outcomes = request.states.map((state) => sourceOutcome(state, evidence));
  const conflicts = merged?.codes.filter((code) => code.endsWith("_CONFLICT")) ?? [];
  const ranked = rankedFailures(outcomes, conflicts, withoutLabel);
  const { complete, ingredientsMissing, formulaSource } = progressCompletion(
    merged,
    evidence,
    untried,
  );
  const remaining = complete
    ? ranked.filter((entry) => !resolvedPartialFailure(entry.failure, evidence))
    : ranked;
  const reason = finalReason({
    ingredientsMissing,
    formulaSource,
    untried,
    policy: request.input.failurePolicy,
    remaining,
  });
  const conflictDetails = conflictLists(conflicts, eligible);
  return progressReport({
    complete,
    terminal: evidence.terminal,
    reason,
    failures: remaining.map((entry) => entry.failure),
    sourceOutcomes: noSourceDiagnostics(request.input.failurePolicy, evidence, reason),
    conflicts: conflictDetails,
    outcomes,
    codes: merged?.codes ?? [],
    ingredientsMissing,
    untried,
  });
}

function mergeProgressEvidence(request: OrderedProgress, evidence: DiagnosedOrderedEvidence) {
  const withoutLabel = noLabelSources(evidence);
  const eligible = {
    entries: evidence.entries,
    failures: evidence.failures.filter((failure) => !withoutLabel.has(failure.id)),
  };
  const sources = evidence.sources.filter((source) => !withoutLabel.has(source.id));
  const merged = sources.length
    ? mergeLabelProduct(
        {
          operationId: request.input.operationId,
          observation: request.input.owner,
          evidencePolicy: request.input.evidencePolicy,
          sources,
        },
        eligible,
      )
    : null;
  return { withoutLabel, eligible, merged };
}

function finalReason(at: {
  ingredientsMissing: boolean;
  formulaSource: NonNullable<DiagnosedOrderedEvidence["sourceDiagnostics"]>[number] | undefined;
  untried: number;
  policy: OrderedFailurePolicy | undefined;
  remaining: ReturnType<typeof rankedFailures>;
}): SourceFailure | undefined {
  if (at.ingredientsMissing && at.untried === 0 && at.formulaSource) {
    return {
      sourceId: at.formulaSource.sourceId,
      code: "LABEL.INGREDIENTS_INCOMPLETE",
      executionFact: "executed",
    };
  }
  return primaryOrderedFailure(at.policy, at.remaining);
}

/** The lists that disagreed travel with the Review (2026-10-21): 597 conflict Reviews carried none to compare. */
function conflictLists(
  conflicts: string[],
  eligible: { entries: VerifiedLabelSource[]; failures: MergeFailure[] },
) {
  if (
    !conflicts.includes("LABEL_PRODUCT.INGREDIENTS_CONFLICT") &&
    !conflicts.includes("LABEL_PRODUCT.FORMULA_CONFLICT")
  ) {
    return null;
  }
  const sources = [
    ...eligible.entries,
    ...eligible.failures.flatMap((failure) =>
      failure.candidate ? [{ id: failure.id, candidate: failure.candidate }] : [],
    ),
  ];
  return [
    ...(conflicts.includes("LABEL_PRODUCT.INGREDIENTS_CONFLICT")
      ? ingredientConflictDetails(sources)
      : []),
    ...(conflicts.includes("LABEL_PRODUCT.FORMULA_CONFLICT")
      ? formulaConflictDetails(sources)
      : []),
  ].filter((conflict) => conflict.sources.length);
}

export function noLabelSources(evidence: DiagnosedOrderedEvidence) {
  const ids = evidence.failures.filter(imageReviewWithoutLabel).map((failure) => failure.id);
  for (const diagnostic of evidence.sourceDiagnostics ?? []) {
    if (diagnostic.status === "review" && diagnostic.reason === "model_no_label") {
      ids.push(diagnostic.sourceId);
    }
  }
  return new Set(ids);
}

function noSourceDiagnostics(
  policy: OrderedFailurePolicy | undefined,
  evidence: DiagnosedOrderedEvidence,
  reason: SourceFailure | undefined,
) {
  return policy === "source-failure-first/2" && reason?.code === "CHANNEL.LABEL_NO_SOURCE"
    ? noSourceSummary(evidence)
    : undefined;
}

function rankedFailures(
  outcomes: ReturnType<typeof sourceOutcome>[],
  conflicts: string[],
  withoutLabel: Set<string>,
) {
  return outcomes.flatMap((outcome, index) => {
    const conflict = sourceConflict(outcome.sections, conflicts);
    const code = conflict ?? outcome.code;
    if (!code) {
      return [];
    }
    const failure: SourceFailure = {
      sourceId: outcome.sourceId,
      code,
      executionFact: outcome.executionFact,
    };
    return [
      {
        failure,
        progress: outcome.progress + (conflict ? 10 : 0),
        index,
        noLabel: withoutLabel.has(outcome.sourceId),
      },
    ];
  });
}

/** /1 breaks equal-progress ties; /2 always ranks a real failure above an absent label. */
export function primaryOrderedFailure(
  policy: OrderedFailurePolicy | undefined,
  ranked: { failure: SourceFailure; progress: number; index: number; noLabel?: boolean }[],
) {
  const useful = (entry: (typeof ranked)[number]) =>
    policy && entry.failure.code !== "CHANNEL.LABEL_NO_SOURCE" && !entry.noLabel ? 1 : 0;
  const first = [...ranked].sort(
    (left, right) =>
      Number(!!left.noLabel) - Number(!!right.noLabel) ||
      (policy === "source-failure-first/2" ? useful(right) - useful(left) : 0) ||
      right.progress - left.progress ||
      useful(right) - useful(left) ||
      right.index - left.index,
  )[0];
  return first?.noLabel ? { ...first.failure, code: "CHANNEL.LABEL_NO_SOURCE" } : first?.failure;
}

function sourceConflict(sections: string[], conflicts: string[]) {
  return conflicts.find(
    (code) =>
      (sections.includes("formula") &&
        [
          assemblyErrors.code("LABEL_PRODUCT.FORMULA_CONFLICT"),
          assemblyErrors.code("LABEL_PRODUCT.SOURCE_NUMERIC_CONFLICT"),
        ].some((candidate) => candidate === code)) ||
      (sections.includes("ingredients") &&
        code === assemblyErrors.code("LABEL_PRODUCT.INGREDIENTS_CONFLICT")),
  );
}
