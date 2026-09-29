import type {
  LabelProductFormulaSchema,
  LabelProductOtherSchema,
} from "@crawl-automation/v3-contracts";
import type { z } from "zod";
import {
  amountLines,
  labelLines,
  normalizeLabel,
  otherIngredientItems,
} from "./label-text-lines.js";

type Formula = z.infer<typeof LabelProductFormulaSchema>;
type OtherIngredients = z.infer<typeof LabelProductOtherSchema>;

/** A saved formula, as the collected product stores it. */
export interface SavedFormula {
  formula: Formula;
  otherIngredients: OtherIngredients;
}

/** Why a sibling's formula does not fit this label; each names the part that differs. */
export type LabelMismatch =
  | { kind: "serving-size"; expected: string }
  | { kind: "row-missing"; name: string; amount: string | null }
  | { kind: "row-extra"; line: string }
  | { kind: "other-ingredients"; expected: string[] | null; printed: string[] | null };

export type SiblingLabelCheck = { match: true } | { match: false; mismatches: LabelMismatch[] };

interface Row {
  name: string;
  amount: string | null;
}

function formulaRows(formula: Formula): Row[] {
  return formula.columns.flatMap((column) =>
    column.rows.map((row) => ({
      name: normalizeLabel(row.name.text),
      amount: row.amount ? normalizeLabel(row.amount.text) : null,
    })),
  );
}

/** Every saved row is printed on one line of this label, with the same amount. */
function missingRows(rows: readonly Row[], lines: readonly string[]): LabelMismatch[] {
  const printed = (row: Row) =>
    lines.some((line) => line.includes(row.name) && (!row.amount || line.includes(row.amount)));
  return rows
    .filter((row) => !printed(row))
    .map((row) => ({ kind: "row-missing" as const, name: row.name, amount: row.amount }));
}

/** Every amount this label prints belongs to a saved row: a new ingredient means a new formula. */
function extraRows(rows: readonly Row[], lines: readonly string[]): LabelMismatch[] {
  return amountLines(lines)
    .filter((line) => !rows.some((row) => line.includes(row.name)))
    .map((line) => ({ kind: "row-extra" as const, line }));
}

function savedOthers(otherIngredients: OtherIngredients): string[] {
  const items = otherIngredients?.items.map((item) => normalizeLabel(item.text)) ?? [];
  return items.length === 1 && items[0] === "none" ? [] : items;
}

function otherIngredientsMismatch(
  otherIngredients: OtherIngredients,
  lines: readonly string[],
): LabelMismatch[] {
  const expected = savedOthers(otherIngredients);
  const printed = otherIngredientItems(lines) ?? [];
  const same =
    expected.length === printed.length && expected.every((item, index) => item === printed[index]);
  return same ? [] : [{ kind: "other-ingredients", expected, printed }];
}

/**
 * Whether a label (the new size's supplement facts, as text) prints exactly a sibling's saved formula: the same
 * serving size, every row with the same amount, no extra amount rows, and the same other ingredients in the same
 * order. Servings per container may differ: that is what a size difference is. Anything unclear is a mismatch.
 */
export function checkSiblingLabel(labelText: string, saved: SavedFormula): SiblingLabelCheck {
  const lines = labelLines(labelText);
  const mismatches: LabelMismatch[] = [];
  const serving = saved.formula.servingSize?.text;
  if (serving && !lines.some((line) => line.includes(normalizeLabel(serving)))) {
    mismatches.push({ kind: "serving-size", expected: normalizeLabel(serving) });
  }
  const rows = formulaRows(saved.formula);
  mismatches.push(...missingRows(rows, lines), ...extraRows(rows, lines));
  mismatches.push(...otherIngredientsMismatch(saved.otherIngredients, lines));
  return mismatches.length === 0 ? { match: true } : { match: false, mismatches };
}
