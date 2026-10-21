import {
  formulaAgreement,
  ingredientListRelation,
  ingredientWordingKey,
  type LabelCandidate,
} from "@crawl-automation/v3-contracts";

const words = (field: { text: string } | null | undefined) =>
  field?.text.replace(/\s+/gu, " ").trim().toLowerCase();
type Formula = NonNullable<LabelCandidate["formula"]>;

/**
 * The shared agreement decides first (2026-10-21): a reading whose rows are prefixes of the full panel's, a split
 * component line, or a separate section of the same panel does not contradict it. The exact row matcher stays as the
 * fallback for partial panels that read fewer columns than the full label.
 */
export function formulaFits(partial: Formula, complete: Formula): boolean {
  return formulaAgreement(partial, complete) !== "conflict" || rowsFit(partial, complete);
}

function rowsFit(partial: Formula, complete: Formula): boolean {
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

export function ingredientsFit(partial: LabelCandidate, complete: LabelCandidate): boolean {
  // Wording-only differences are one item, as in the full-label comparison (owner 2026-10-09, CRAWLV3-214).
  const key = (item: { text: string }) => ingredientWordingKey(item.text);
  const wanted = partial.otherIngredients?.items.map(key) ?? [];
  const available = complete.otherIngredients?.items.map(key) ?? [];
  // The same relation the selection uses: a list that one source prints fewer items of, or in another order, is a
  // warning there (INGREDIENTS_SUBSET / INGREDIENTS_REORDERED), so it is not a conflict here either (2026-10-21).
  if (
    wanted.length &&
    available.length &&
    ingredientListRelation(wanted, available) !== "conflict"
  ) {
    return true;
  }
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
