import { mergeLabelProduct } from "../assembly/label-merge.js";
import { assemblyErrors } from "../assembly/assembly-errors.js";
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
  const merged = evidence.sources.length
    ? mergeLabelProduct(
        {
          operationId: request.input.operationId,
          observation: request.input.owner,
          evidencePolicy: request.input.evidencePolicy,
          sources: evidence.sources,
        },
        evidence,
      )
    : null;
  const outcomes = request.states.map((state) => sourceOutcome(state, evidence));
  const conflicts = merged?.codes.filter((code) => code.endsWith("_CONFLICT")) ?? [];
  const ranked = rankedFailures(outcomes, conflicts);
  const reason = primaryOrderedFailure(request.input.failurePolicy, ranked);
  return {
    complete: !evidence.terminal && completeLabel(merged, untried),
    terminal: evidence.terminal,
    ...(reason ? { reason, failures: ranked.map((entry) => entry.failure) } : {}),
    ...noSourceDiagnostics(request.input.failurePolicy, evidence, reason),
    outcomes,
    codes: merged?.codes ?? [],
  };
}

function noSourceDiagnostics(
  policy: OrderedFailurePolicy | undefined,
  evidence: DiagnosedOrderedEvidence,
  reason: SourceFailure | undefined,
) {
  return policy === "source-failure-first/2" && reason?.code === "CHANNEL.LABEL_NO_SOURCE"
    ? { sourceOutcomes: noSourceSummary(evidence) }
    : {};
}

function rankedFailures(outcomes: ReturnType<typeof sourceOutcome>[], conflicts: string[]) {
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
    return [{ failure, progress: outcome.progress + (conflict ? 10 : 0), index }];
  });
}

/** Ready, and either with a formula or with every source tried. */
function completeLabel(merged: ReturnType<typeof mergeLabelProduct> | null, untried: number) {
  return merged?.status === "ready" && ((merged.parts?.formulaFound ?? true) || untried === 0);
}

/** /1 breaks equal-progress ties; /2 always ranks a real failure above an absent label. */
export function primaryOrderedFailure(
  policy: OrderedFailurePolicy | undefined,
  ranked: { failure: SourceFailure; progress: number; index: number }[],
) {
  const useful = (code: string) => (policy && code !== "CHANNEL.LABEL_NO_SOURCE" ? 1 : 0);
  return [...ranked].sort(
    (left, right) =>
      (policy === "source-failure-first/2"
        ? useful(right.failure.code) - useful(left.failure.code)
        : 0) ||
      right.progress - left.progress ||
      useful(right.failure.code) - useful(left.failure.code) ||
      right.index - left.index,
  )[0]?.failure;
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
