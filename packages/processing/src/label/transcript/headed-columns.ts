import {
  columnRole,
  US_FACTS,
  type ColumnRole,
  type LabelFormatId,
} from "@crawl-automation/v3-contracts";
import type { TranscriptRow } from "./html-transcript.js";

export interface HeadedColumns {
  amountAt: number | null;
  /** How many headed columns print amounts (per serving or per a fixed basis). */
  amountColumns: number;
  dvAt: number | null;
  amountHeading: string | null;
  dailyValueHeading: string | null;
}

/**
 * The headed amount column (per serving, else the fixed-basis one) and the first percentage column, when the printed
 * headers name a column only a non-US format knows; null leaves each cell to be read by its own text.
 */
export function headedColumns(
  headers: readonly string[],
  formats: readonly LabelFormatId[],
): HeadedColumns | null {
  const roles = headers.map((header) => (header.trim() ? columnRole(header, formats) : null));
  if (!roles.some((role) => role && role.format !== US_FACTS)) {
    return null;
  }
  const at = (role: ColumnRole["role"]) => {
    const found = roles.findIndex((known) => known?.role === role);
    return found < 0 ? null : found;
  };
  const amountAt = at("amount") ?? at("per_basis");
  const dvAt = at("daily_value");
  const text = (index: number | null) => (index === null ? null : (headers[index]?.trim() ?? null));
  const amountColumns = roles.filter(
    (role) => role?.role === "amount" || role?.role === "per_basis",
  ).length;
  return {
    amountAt,
    dvAt,
    amountColumns,
    amountHeading: text(amountAt),
    dailyValueHeading: text(dvAt),
  };
}

/**
 * Value-cell positions of the headed columns in this row. The headers either include the name column's or not; a
 * row of the name alone (a group heading) has no values. Any other width cannot be placed under its headers.
 */
export function rowColumns(
  cells: readonly string[],
  headers: number,
  at: Pick<HeadedColumns, "amountAt" | "dvAt" | "amountColumns">,
): TranscriptRow["columns"] | null {
  const values = cells.length - 1;
  if (values === 0) {
    return { amount: null, dailyValue: null };
  }
  const shift = headers - values;
  if (shift !== 0 && shift !== 1) {
    return loneAmount(cells, at);
  }
  const place = (header: number | null) =>
    header === null || header - shift < 0 ? null : header - shift;
  return { amount: place(at.amountAt), dailyValue: place(at.dvAt) };
}

/**
 * Owner 2026-11-08 (HealthyHey Magnesium Glycinate on amazon.in): "Energy Value = 0 kcal Protein = 0 g …" printed as
 * one running line under a table headed "Amount Per Serving | %RDA Men | %RDA Women" is copied one nutrient per row,
 * its name and its amount. With one amount column that amount belongs to no other; with several (per 100 g and per
 * serving), an empty cell or a percentage, the row stays unaligned.
 */
function loneAmount(
  cells: readonly string[],
  at: Pick<HeadedColumns, "amountColumns">,
): TranscriptRow["columns"] | null {
  const [, amount = ""] = cells;
  return cells.length === 2 && at.amountColumns === 1 && amount.trim() && !amount.includes("%")
    ? { amount: 0, dailyValue: null }
    : null;
}
