import type { MergedLabel } from "../assembly/label-merge.js";
import type { SourceFailure } from "./ordered-model.js";
import type { DiagnosedOrderedEvidence } from "./ordered-source-outcome.js";
import { noSourceSummary, sourceOutcome } from "./ordered-source-outcome.js";

/**
 * A formula-only image waits for the remaining sources to supply a usable ingredient section; once no source is
 * left untried it is a formula-only product, like an ingredients-only one (owner 2026-10-06, again 2026-10-25:
 * ingredients, health functions and form are enough).
 */
export function progressCompletion(
  merged: MergedLabel | null,
  evidence: DiagnosedOrderedEvidence,
  untried: number,
) {
  const formulaSource = evidence.sourceDiagnostics?.find(
    (item) => item.reason === "partial: formula only",
  );
  const ingredientsMissing = needsIngredients(merged, !!formulaSource);
  return {
    formulaSource,
    ingredientsMissing,
    complete:
      !evidence.terminal &&
      (!ingredientsMissing || untried === 0) &&
      merged?.status === "ready" &&
      ((merged.parts?.formulaFound ?? true) || untried === 0),
  };
}

function needsIngredients(merged: MergedLabel | null, formulaSourceFound: boolean) {
  return (
    formulaSourceFound &&
    !!merged &&
    !(merged.parts?.ingredientsFound ?? merged.otherIngredients !== null)
  );
}

/**
 * Once the label completes (both sections, or one part after every source), the per-image missing-section codes are
 * resolved.
 */
export function resolvedPartialFailure(failure: SourceFailure, evidence: DiagnosedOrderedEvidence) {
  const section = evidence.sourceDiagnostics?.find(
    (item) => item.sourceId === failure.sourceId,
  )?.reason;
  return (
    (section === "partial: formula only" &&
      ["VISION.LABEL_INGREDIENTS_INCOMPLETE", "LABEL.INGREDIENTS_INCOMPLETE"].includes(
        failure.code,
      )) ||
    (section === "partial: ingredients only" &&
      ["VISION.LABEL_FORMULA_INCOMPLETE", "LABEL.FORMULA_INCOMPLETE"].includes(failure.code))
  );
}

interface ProgressReport {
  complete: boolean;
  terminal: boolean;
  reason?: SourceFailure;
  failures?: SourceFailure[];
  sourceOutcomes?: ReturnType<typeof noSourceSummary> | undefined;
  conflicts?: unknown;
  outcomes: ReturnType<typeof sourceOutcome>[];
  codes: string[];
}

export function progressReport(at: {
  complete: boolean;
  terminal: boolean;
  reason: SourceFailure | undefined;
  failures: SourceFailure[];
  sourceOutcomes?: ReturnType<typeof noSourceSummary> | undefined;
  conflicts?: unknown;
  outcomes: ReturnType<typeof sourceOutcome>[];
  codes: string[];
  ingredientsMissing: boolean;
  untried: number;
}): ProgressReport {
  const { reason } = at;
  return {
    complete: at.complete,
    terminal: at.terminal,
    ...(reason
      ? {
          reason,
          failures: [
            ...at.failures,
            ...(reason.code === "LABEL.INGREDIENTS_INCOMPLETE" ? [reason] : []),
          ],
        }
      : {}),
    ...(at.sourceOutcomes ? { sourceOutcomes: at.sourceOutcomes } : {}),
    ...(at.conflicts ? { conflicts: at.conflicts } : {}),
    outcomes: at.outcomes,
    codes:
      at.ingredientsMissing && at.untried === 0
        ? [...at.codes, "LABEL.INGREDIENTS_INCOMPLETE"]
        : at.codes,
  };
}
