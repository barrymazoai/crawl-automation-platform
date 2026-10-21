import type { LabelRule } from "./rule.js";
import { rowName, type LabelRow } from "./rows.js";

/** One cell of a multi-column Facts panel: the row at `index` in column `column`, with every column to compare. */
export interface CellSubject {
  columns: readonly { rows: readonly LabelRow[] }[];
  column: number;
  index: number;
}

const printedName = (row: LabelRow) => row.name.text.replace(/\s+/gu, " ").trim().toLowerCase();

const cellRow = (subject: CellSubject): LabelRow | undefined =>
  subject.columns[subject.column]?.rows[subject.index];

/** A nutrient row of a multi-column panel whose cell in this column prints nothing: no amount, no DV. */
function isEmptyCell(subject: CellSubject, row: LabelRow): boolean {
  return (
    subject.columns.length > 1 &&
    row.kind === "nutrient" &&
    row.amount === null &&
    row.dailyValue === null &&
    (row.amountStatus === "not_applicable" || row.amountStatus === "not_declared")
  );
}

/**
 * The cell's own column is a dose column: it prints an amount for another row. A "% Daily Value" column the model
 * returned as a column of its own (B000F4VD66, B08VJ752GM, B0C2TXLW5R in the 2026-10-21 replay) prints none.
 */
function ownColumnPrintsAmounts(subject: CellSubject): boolean {
  return (subject.columns[subject.column]?.rows ?? []).some(
    (other, at) =>
      at !== subject.index &&
      other.kind === "nutrient" &&
      other.amountStatus === "printed" &&
      other.amount !== null,
  );
}

/** The same ingredient carries a printed amount in another column of the same panel. */
function printedInSiblingColumn(subject: CellSubject, row: LabelRow): boolean {
  const name = printedName(row);
  return subject.columns.some(
    (column, at) =>
      at !== subject.column &&
      column.rows.some(
        (other) =>
          other.kind === "nutrient" &&
          other.amountStatus === "printed" &&
          other.amount !== null &&
          printedName(other) === name,
      ),
  );
}

/**
 * Sambucol Day & Night capsules print one Supplement Facts table with a Day column and a Night column; California
 * Poppy has a blank Day cell and 500 mg at Night. The model reported the blank cell as printed, and the row checks
 * read it as a missing dose (VISION.LABEL_AMOUNT_STATE_CONFLICT on every attempt). A blank cell is the label's own
 * layout when the same ingredient has a printed amount in another column; a row blank in every column is still a
 * missing dose, and a column that prints no amount at all (a "% Daily Value" column returned as a dose column) is not
 * a dose column whose blank cells can be accepted.
 */
export const emptyCellRule: LabelRule<CellSubject> = {
  id: "empty-cell-printed-in-sibling-column",
  code: "LABEL.AMOUNT_MISSING",
  added: "2026-10-21",
  why: "A multi-column panel leaves a cell blank when that column's dose omits the ingredient (Sambucol Day/Night); the blank is accepted only when another column prints the ingredient's amount.",
  check(subject) {
    const row = cellRow(subject);
    if (!row || !isEmptyCell(subject, row)) {
      return null;
    }
    if (!ownColumnPrintsAmounts(subject)) {
      return `row ${subject.index} ${rowName(row)}: empty cell in column ${subject.column}, which prints no amounts`;
    }
    return printedInSiblingColumn(subject, row)
      ? null
      : `row ${subject.index} ${rowName(row)}: empty cell in column ${subject.column} and no printed amount for it in another column`;
  },
};

/** The rows of `column` the rule accepts as blank cells; the row checks skip their amount findings. */
export function acceptedEmptyCells(
  columns: CellSubject["columns"],
  column: number,
): Set<number> {
  const accepted = new Set<number>();
  columns[column]?.rows.forEach((row, index) => {
    const subject = { columns, column, index };
    if (isEmptyCell(subject, row) && ownColumnPrintsAmounts(subject) && printedInSiblingColumn(subject, row)) {
      accepted.add(index);
    }
  });
  return accepted;
}
