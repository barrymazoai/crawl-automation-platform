import { blendPercentageRule } from "./blend-percentage.js";
import { ingredientNotOnlyParenthesisRule } from "./ingredient-items.js";
import { parentRule } from "./parent.js";
import { servingSizeEquivalences } from "./serving-size.js";

export * from "./rule.js";
export type { LabelRow, RowSubject } from "./rows.js";
export { blendPercentageRule } from "./blend-percentage.js";
export { ingredientNotOnlyParenthesisRule } from "./ingredient-items.js";
export { parentRule, openGroupsBefore } from "./parent.js";
export { servingSizeEquivalences, sameServingSize } from "./serving-size.js";

/** Every rule in the table, by kind; the table test requires examples for each ID. */
export const labelRuleTable = {
  rows: [parentRule, blendPercentageRule],
  ingredientItems: [ingredientNotOnlyParenthesisRule],
  servingSize: servingSizeEquivalences,
} as const;
