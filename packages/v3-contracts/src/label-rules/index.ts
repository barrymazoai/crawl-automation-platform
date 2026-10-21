import { blendPercentageRule } from "./blend-percentage.js";
import { emptyCellRule } from "./empty-cell.js";
import { dailyValueOnlyRowRule } from "./daily-value-only-row.js";
import { amountEnclosedInNameRule } from "./amount-enclosed-in-name.js";
import { ingredientListNotAFormulaRule } from "./ingredient-list-not-a-formula.js";
import { ingredientNotOnlyParenthesisRule } from "./ingredient-items.js";
import { parentRule } from "./parent.js";
import { servingSizeEquivalences } from "./serving-size.js";
import { bracketedMayContainIsNotADeclarationRule } from "./bracketed-may-contain-is-not-a-declaration.js";
import { servingsPerContainerUncertaintyIsAWarningRule } from "./servings-per-container-uncertainty-is-a-warning.js";

export * from "./rule.js";
export type { LabelRow, RowSubject } from "./rows.js";
export { blendPercentageRule } from "./blend-percentage.js";
export { emptyCellRule, acceptedEmptyCells, type CellSubject } from "./empty-cell.js";
export { dailyValueOnlyRowRule, acceptsDailyValueOnlyRow, type DailyValueCell } from "./daily-value-only-row.js";
export { amountEnclosedInNameRule, acceptsAmountInName } from "./amount-enclosed-in-name.js";
export { ingredientListNotAFormulaRule, isIngredientListFormula } from "./ingredient-list-not-a-formula.js";
export { ingredientNotOnlyParenthesisRule } from "./ingredient-items.js";
export { parentRule, openGroupsBefore } from "./parent.js";
export { servingSizeEquivalences, sameServingSize } from "./serving-size.js";
export { bracketedMayContainIsNotADeclarationRule, outsideBrackets } from "./bracketed-may-contain-is-not-a-declaration.js";
export { servingsPerContainerUncertaintyIsAWarningRule, type ServingUncertaintySubject } from "./servings-per-container-uncertainty-is-a-warning.js";

/** Every rule in the table, by kind; the table test requires examples for each ID. */
export const labelRuleTable = {
  rows: [parentRule, blendPercentageRule, amountEnclosedInNameRule],
  ingredientItems: [ingredientNotOnlyParenthesisRule],
  cells: [emptyCellRule],
  dailyValueCells: [dailyValueOnlyRowRule],
  formulas: [ingredientListNotAFormulaRule],
  ingredientRoles: [bracketedMayContainIsNotADeclarationRule],
  servingUncertainty: [servingsPerContainerUncertaintyIsAWarningRule],
  servingSize: servingSizeEquivalences,
} as const;
