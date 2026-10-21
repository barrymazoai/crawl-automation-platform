import { blendPercentageRule } from "./blend-percentage.js";
import { emptyCellRule } from "./empty-cell.js";
import { ingredientNotOnlyParenthesisRule } from "./ingredient-items.js";
import { parentRule } from "./parent.js";
import { servingSizeEquivalences } from "./serving-size.js";

export * from "./rule.js";
export type { LabelRow, RowSubject } from "./rows.js";
export { blendPercentageRule } from "./blend-percentage.js";
export { emptyCellRule, acceptedEmptyCells, type CellSubject } from "./empty-cell.js";
export { ingredientNotOnlyParenthesisRule } from "./ingredient-items.js";
export { parentRule, openGroupsBefore } from "./parent.js";
export { servingSizeEquivalences, sameServingSize } from "./serving-size.js";

/** Every rule in the table, by kind; the table test requires examples for each ID. */
export const labelRuleTable = {
  rows: [parentRule, blendPercentageRule],
  ingredientItems: [ingredientNotOnlyParenthesisRule],
  cells: [emptyCellRule],
  servingSize: servingSizeEquivalences,
} as const;
