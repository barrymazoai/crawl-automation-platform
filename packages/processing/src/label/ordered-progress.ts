import { mergeLabelProduct } from "../assembly/label-merge.js";
import { assemblyErrors } from "../assembly/assembly-errors.js";
import { sourceOutcome } from "./ordered-source-outcome.js";
import type { OrderedEvidence, OrderedProgress, SourceFailure } from "./ordered-model.js";

/** Completeness and conflicts come from the same merger used by assembly and collection. */
export function orderedProgress(request: OrderedProgress, evidence: OrderedEvidence) {
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
  const ranked = outcomes.flatMap((outcome, index) => {
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
  const reason = [...ranked].sort(
    (left, right) => right.progress - left.progress || right.index - left.index,
  )[0]?.failure;
  return {
    complete: !evidence.terminal && merged?.status === "ready",
    terminal: evidence.terminal,
    ...(reason ? { reason, failures: ranked.map((entry) => entry.failure) } : {}),
    outcomes,
    codes: merged?.codes ?? [],
  };
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
