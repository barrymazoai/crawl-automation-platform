import type { LabelTextCandidate } from "../label-extraction.js";
import type { LabelRule } from "./rule.js";

export type IngredientParagraphSubject = {
  candidate: LabelTextCandidate;
  text: string;
  range: { start: number; end: number };
};

type Quote = { text: string; start: number; end: number };
const panelEvidence =
  /\b(?:supplement|nutrition|drug)\s+facts\b|amount\s+per\s+serving|serving\s+size|servings\s+per\s+container/iu;
const printedDose = /\b\d+(?:[.,]\d+)?\s*(?:mcg|µg|mg|g|kg|iu|cfu|ml)\b|\b\d+(?:[.,]\d+)?\s*%/iu;

/** A complete, comma-separated Ingredients paragraph, cited as undosed formula rows. */
export function undosedIngredientParagraph(subject: IngredientParagraphSubject): {
  heading: Quote;
  items: Quote[];
} | null {
  const { candidate, text, range } = subject;
  const formula = candidate.formula;
  if (
    !formula ||
    formula.drugFacts ||
    formula.servingSize ||
    formula.servingsPerContainer ||
    formula.columns.length !== 1 ||
    formula.columns[0]?.heading
  )
    return null;
  const source = text.slice(range.start, range.end);
  if (panelEvidence.test(source)) return null;
  const headingMatch = /^\s*(Ingredients)(?::)?(?=\s)/iu.exec(source);
  if (!headingMatch) return null;
  const headingStart = range.start + headingMatch[0].indexOf(headingMatch[1]!);
  const heading = {
    text: headingMatch[1]!,
    start: headingStart,
    end: headingStart + headingMatch[1]!.length,
  };
  const rows = formula.columns[0]!.rows;
  if (
    rows.length < 2 ||
    rows.some(
      (row) =>
        row.kind !== "nutrient" ||
        row.parentRowIndex !== null ||
        row.amount !== null ||
        row.dailyValue !== null ||
        !!row.purpose ||
        row.amountStatus !== "not_declared" ||
        printedDose.test(row.name.text) ||
        text.slice(row.name.start, row.name.end) !== row.name.text,
    )
  )
    return null;
  const items = rows.map((row) => row.name);
  if (!/^\s*$/u.test(text.slice(heading.end, items[0]!.start).replace(/^:/u, ""))) return null;
  for (let index = 1; index < items.length; index++) {
    if (!/^\s*,\s*$/u.test(text.slice(items[index - 1]!.end, items[index]!.start))) return null;
  }
  if (!/^\s*\.?\s*$/u.test(text.slice(items.at(-1)!.end, range.end))) return null;
  const other = candidate.otherIngredients;
  if (
    other &&
    (!/^Ingredients\s*:?$/iu.test(other.heading.text.trim()) ||
      other.items.length !== items.length ||
      other.items.some(
        (item, index) => item.start !== items[index]!.start || item.end !== items[index]!.end,
      ))
  )
    return null;
  return { heading, items };
}

export const undosedIngredientParagraphRule: LabelRule<IngredientParagraphSubject> = {
  id: "undosed-ingredient-paragraph",
  code: "LABEL.FORMULA_IS_INGREDIENT_LIST",
  added: "2026-10-21",
  why: "Stored Ingredients paragraphs such as text-fbea7a7e and text-fe52455c were decoded with undosed formula rows even though their rows are the comma-separated list itself.",
  check(subject) {
    return undosedIngredientParagraph(subject)
      ? null
      : "source is not a complete undosed Ingredients paragraph";
  },
};
