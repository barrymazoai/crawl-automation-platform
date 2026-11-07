import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { drugHeadingAliasesAllowed } from "./drug-label.js";
import { compositionHeading, readsComposition } from "./composition-clause.js";
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
      return (
        !misplacedRowsExplainCompleteness(candidate) && !compositionIsTheIngredients(candidate)
      );
    }
    return true;
  });
}

/**
 * Owner 2026-11-07 (Dabur Sat Isabgol on amazon.in: "Ingredients: Each 10 g contains: Isabgol (Plantago ovata, Sd.
 * Husk) 10 g"): a page whose ingredients statement is a dosed composition prints no separate list, so "ingredients
 * complete" with no list is that composition, not a contradiction. The formula is kept; no list is made up.
 */
function compositionIsTheIngredients(candidate: LabelTextCandidate): boolean {
  const rows = candidate.formula?.columns.flatMap((column) => column.rows) ?? [];
  // A composition heading read as a row ("Each 100 ml Juice/Swaras contains:", Krishna's) is a misread answer.
  const headingRow = rows.some((row) => compositionHeading(row.name.text));
  return (
    rows.some((row) => row.amount) &&
    !headingRow &&
    candidate.otherIngredients === null &&
    !candidate.issues.some(
      (issue) => issue.code === "INGREDIENTS_MISSING" || issue.code === "FORMULA_MISSING",
    ) &&
    readsComposition(candidate)
  );
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
