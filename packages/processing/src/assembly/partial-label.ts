import {
  assessLabelCandidate,
  partialLabelValidationCodes,
  type LabelCandidate,
} from "@crawl-automation/v3-contracts";
import { labelValidationErrors } from "../label/validation-errors.js";
import { assemblyErrors } from "./assembly-errors.js";

export const partialLabelCodes: readonly string[] = partialLabelValidationCodes.map((code) =>
  labelValidationErrors.code(code),
);

const words = (field: { text: string } | null | undefined) =>
  field?.text.replace(/\s+/gu, " ").trim().toLowerCase();
type Formula = NonNullable<LabelCandidate["formula"]>;

/**
 * A partial panel may omit unreadable content, but every readable field must agree with the full label. A part the
 * selected label does not carry (/7) is not compared: there is nothing to disagree with.
 */
export function partialLabelConflicts(
  partial: LabelCandidate,
  complete: LabelCandidate,
  parts: { formula: boolean; ingredients: boolean } = { formula: true, ingredients: true },
): string[] {
  const codes: string[] = [];
  const formula = parts.formula && partial.formula;
  if (formula && (!complete.formula || !formulaFits(formula, complete.formula))) {
    codes.push(assemblyErrors.code("LABEL_PRODUCT.FORMULA_CONFLICT"));
  }
  if (parts.ingredients && partial.otherIngredients && !ingredientsFit(partial, complete)) {
    codes.push(assemblyErrors.code("LABEL_PRODUCT.INGREDIENTS_CONFLICT"));
  }
  return codes;
}

/** Refuse ambiguous content and all errors beyond the explicitly allowed incomplete-panel codes. */
export function isPartialLabel(candidate: LabelCandidate): boolean {
  const assessed = assessLabelCandidate(candidate);
  const incomplete =
    !candidate.formulaComplete || !candidate.ingredientsComplete || assessed.status === "review";
  return (
    incomplete &&
    !candidate.issues.some((issue) => ["AMBIGUOUS", "METADATA_CONFLICT"].includes(issue.code)) &&
    assessed.codes.every((code) => partialLabelCodes.includes(code))
  );
}

function formulaFits(partial: Formula, complete: Formula): boolean {
  if (
    ["servingSize", "servingsPerContainer", "drugFacts"].some((key) => {
      const field = key as "servingSize" | "servingsPerContainer" | "drugFacts";
      return partial[field] && words(partial[field]) !== words(complete[field]);
    })
  ) {
    return false;
  }
  return partial.columns.every((column) => {
    const matches = complete.columns.filter(
      (full) => words(full.heading) === words(column.heading),
    );
    const full = matches[0];
    return (
      matches.length === 1 &&
      !!full &&
      column.rows.every((row) => rowFits(row, { partial: column.rows, complete: full.rows }))
    );
  });
}

type Row = Formula["columns"][number]["rows"][number];
function rowFits(row: Row, rows: { partial: Row[]; complete: Row[] }): boolean {
  const matches = rows.complete.filter(
    (full) => words(full.name) === words(row.name) && full.kind === row.kind,
  );
  const full = matches[0];
  if (
    matches.length !== 1 ||
    !full ||
    parentName(row, rows.partial) !== parentName(full, rows.complete)
  ) {
    return false;
  }
  return (["amount", "dailyValue", "purpose"] as const).every(
    (field) => !row[field] || words(row[field]) === words(full[field]),
  );
}

function parentName(row: Row, rows: Row[]) {
  return row.parentRowIndex === null ? null : words(rows[row.parentRowIndex]?.name);
}

function ingredientsFit(partial: LabelCandidate, complete: LabelCandidate): boolean {
  const wanted = partial.otherIngredients?.items.map(words) ?? [];
  const available = complete.otherIngredients?.items.map(words) ?? [];
  let offset = 0;
  if (partial.ingredientsComplete && wanted.length !== available.length) {
    return false;
  }
  return wanted.every((name) => {
    const index = available.indexOf(name, offset);
    offset = index + 1;
    return index >= 0;
  });
}
