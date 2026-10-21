import { isDeepStrictEqual } from "node:util";
import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";

/** Neutralize only the permitted edits, then compare every remaining field exactly. */
export function sameRepairContent(
  before: LabelImageCandidate,
  after: LabelImageCandidate,
  allowIngredientBoundary: boolean,
): boolean {
  const left = structuredClone(before);
  const right = structuredClone(after);
  if (!!left.formula !== !!right.formula || !!left.otherIngredients !== !!right.otherIngredients) {
    return false;
  }
  if (!sameRows(left, right) || !sameIngredients(left, right, allowIngredientBoundary)) {
    return false;
  }
  return isDeepStrictEqual(left, right);
}

function sameRows(left: LabelImageCandidate, right: LabelImageCandidate): boolean {
  if (!left.formula || !right.formula) {
    return true;
  }
  if (left.formula.columns.length !== right.formula.columns.length) {
    return false;
  }
  for (const [index, column] of left.formula.columns.entries()) {
    const next = right.formula.columns[index];
    if (!next || column.rows.length !== next.rows.length) {
      return false;
    }
    for (const [rowIndex, row] of column.rows.entries()) {
      const repaired = next.rows[rowIndex];
      if (!repaired) {
        return false;
      }
      repaired.kind = row.kind;
      repaired.parentRowIndex = row.parentRowIndex;
    }
  }
  return true;
}

function sameIngredients(
  left: LabelImageCandidate,
  right: LabelImageCandidate,
  allowIngredientBoundary: boolean,
): boolean {
  if (!left.otherIngredients || !right.otherIngredients) {
    return true;
  }
  const original = left.otherIngredients.items;
  const repaired = right.otherIngredients.items;
  if (!allowIngredientBoundary && !isDeepStrictEqual(original, repaired)) {
    return false;
  }
  if (ingredientStream(original) !== ingredientStream(repaired)) {
    return false;
  }
  right.otherIngredients.items = original;
  return true;
}

function ingredientStream(items: { text: string }[]): string {
  return items
    .map((item) => item.text)
    .join("")
    .replace(/[,;\s]/gu, "");
}
