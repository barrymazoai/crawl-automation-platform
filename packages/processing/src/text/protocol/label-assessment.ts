import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { drugHeadingAliasesAllowed } from "./drug-label.js";
import { ingredientHeadingAllowed, ingredientItemsAreRows } from "./label-structure.js";

/** Apply text-only heading aliases and replace a misleading completeness code with a precise row-role code. */
export function textAssessmentCodes(
  candidate: LabelTextCandidate,
  codes: readonly string[],
): string[] {
  return codes.filter((code) => {
    if (code === "LABEL.INGREDIENT_HEADING_INVALID") {
      return !candidate.otherIngredients || !ingredientHeadingAllowed(candidate.otherIngredients);
    }
    if (code === "LABEL.FORMULA_INCOMPLETE") {
      return !drugHeadingAliasesAllowed(candidate) || !candidate.formulaComplete;
    }
    if (code === "LABEL.COMPLETENESS_CONFLICT") {
      return !misplacedRowsExplainCompleteness(candidate);
    }
    return true;
  });
}

function misplacedRowsExplainCompleteness(candidate: LabelTextCandidate): boolean {
  return (
    candidate.formula === null &&
    candidate.formulaComplete &&
    !!candidate.otherIngredients &&
    ingredientItemsAreRows(candidate.otherIngredients) &&
    !candidate.issues.some((issue) => issue.code === "INGREDIENTS_MISSING")
  );
}
