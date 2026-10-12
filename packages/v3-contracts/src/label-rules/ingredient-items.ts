import type { LabelRule } from "./rule.js";

export const ingredientNotOnlyParenthesisRule: LabelRule<string> = {
  id: "ingredient-not-only-parenthesis",
  code: "LABEL.INGREDIENT_BOUNDARY",
  added: "2026-09-28",
  why: "An Other Ingredients item that is only a parenthesis (\"(capsule)\") was split off its ingredient.",
  check: (item) =>
    /^\s*\([^()]+\)\s*$/.test(item) ? `ingredient item "${item.slice(0, 80)}" is only a parenthesis` : null,
};
