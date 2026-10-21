import type { LabelCandidate } from "../label-extraction.js";
import type { LabelRule } from "./rule.js";

const title = /^(?:ingredients?|inactive(?:\s+ingredients?)?|active(?:\s+ingredients?)?)\s*:?$/iu;
const facts = /\b(?:supplement|nutrition|drug)\s+facts\b|amount\s+per\s+serving/iu;
const activeSupplement = /^(?:vitamin\b|vit\.|selenium\b|riboflavin\b|zinc\b|igg\b|proprietary\s+blend\b|lactobacillus\b|bifidobacterium\b|.*\b(?:extract|powder|root|herb)\b)/iu;
const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
type Formula = NonNullable<LabelCandidate["formula"]>;
type RowView = { name: { text: string }; amount: unknown | null; dailyValue: unknown | null };

function hasPanelEvidence(formula: Formula): boolean {
  return !!(formula.drugFacts || formula.servingSize || formula.servingsPerContainer) ||
    formula.columns.some((column) => !!column.heading && facts.test(column.heading.text));
}

function allRows(formula: Formula): RowView[] {
  const rows: RowView[] = [];
  for (const column of formula.columns) {
    for (const row of column.rows) rows.push(row);
  }
  return rows;
}

function hasActiveSupplementRows(rows: RowView[], itemCount: number): boolean {
  if (rows.length === 1 && title.test(rows[0]!.name.text)) return false;
  return itemCount < 2 || rows.some((row) => activeSupplement.test(row.name.text));
}

function duplicatedIngredient(row: { name: { text: string } }, items: readonly { text: string }[]): boolean {
  const name = normalized(row.name.text);
  return !!name && items.some((item) => normalized(item.text) === name);
}

/** A model-created formula which only repeats the actual Ingredients list has no printed formula amounts. */
export const ingredientListNotAFormulaRule: LabelRule<LabelCandidate> = {
  id: "ingredient-list-not-a-formula",
  code: "LABEL.FORMULA_IS_INGREDIENT_LIST",
  added: "2026-10-21",
  why: "8572268707978 puts Sodium Palmate in formula despite a matching Ingredients list; B078B9JPLX puts the Ingredients heading there. B0FK9284FC still has a printed Probiotic Blend dose and distinct Other Ingredients, so remains a formula.",
  check(candidate) {
    const formula = candidate.formula;
    const list = candidate.otherIngredients;
    if (!formula || !list) return "no retained ingredient list to carry the partial result";
    if (hasPanelEvidence(formula)) return "formula has a printed panel or serving basis";
    const rows = allRows(formula);
    if (!rows.length || rows.some((row) => row.amount !== null || row.dailyValue !== null)) return "formula contains an amount or daily value";
    if (!/\bingredients?\b/iu.test(list.heading.text) || /^other\s+ingredients?/iu.test(list.heading.text)) return "no primary Ingredients list";
    if (hasActiveSupplementRows(rows, list.items.length)) return "an active supplement row still needs review";
    if (rows.some((row) => !title.test(row.name.text) && !duplicatedIngredient(row, list.items))) return "formula row is not a heading or duplicated ingredient";
    return null;
  },
};

export const isIngredientListFormula = (candidate: LabelCandidate): boolean =>
  ingredientListNotAFormulaRule.check(candidate) === null;
