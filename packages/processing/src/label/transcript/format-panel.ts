import {
  columnRole,
  formatRules,
  isUsOnlyFormats,
  US_FACTS,
  type ColumnRole,
  type LabelFormatId,
} from "@crawl-automation/v3-contracts";
import { marketRules } from "../markets/market-rules.js";
import type { TranscriptRow } from "./html-transcript.js";
import { sideBySide } from "./side-by-side.js";

/** One copied panel, as the vision copy or a page table prints it. */
export interface PrintedPanel {
  heading: string | null;
  servingLines: readonly string[];
  columnHeaders: readonly string[];
  rows: readonly { cells: string[]; indent: number; bold: boolean }[];
}

/** A panel read in its label format: rows for the transcript parser and what the format's own lines print. */
export interface FormatPanel {
  rows: TranscriptRow[];
  servingSize: string | null;
  servingsPerContainer: string | null;
  /** The printed header of the amount column read, when the format names it ("Qty./Serving"). */
  amountHeading: string | null;
  /** The printed header of the percentage column read ("%RDA"). */
  dailyValueHeading: string | null;
}

/**
 * KAN-243: a panel printed in a non-US label format, reshaped for the US transcript parser. Lines the format prints
 * as headings, column headers, serving or pack lines leave the rows; when the printed column headers name the
 * columns ("Qty./Serving | Qty/100g | %RDA"), each row's amount and percentage are the cells under the per-serving
 * and the first percentage header (an Indian %RDA cell prints a bare "100"). Null when only US formats are read: the
 * US panel is parsed exactly as before. A reason when the panel cannot be read in its format.
 */
export function formatPanel(
  panel: PrintedPanel,
  formats: readonly LabelFormatId[],
): FormatPanel | { reason: string } | null {
  if (isUsOnlyFormats(formats)) {
    return null;
  }
  if (preparedFrom(panel, formats)) {
    return { reason: "prepared-from list: raw herb quantities, not the product's contents" };
  }
  const { columnHeaders, rows } = sideBySide(panel);
  const headers = headedColumns(columnHeaders, formats);
  const read = servingRead(panel.servingLines, headers, formats);
  for (const row of rows) {
    if (continues(read, row, formats)) {
      continue;
    }
    const placed = placedRow(read, row, { formats, headers, width: columnHeaders.length });
    if (placed === "unaligned") {
      return { reason: `row not aligned with the column headers: ${row.cells.join(" | ")}` };
    }
    if (placed) {
      read.rows.push(placed);
    }
  }
  read.rows = marketRules(formats).copyRows(panel, read.rows, formats);
  return read;
}

/**
 * KAN-243: the printed percentage header of a copied panel ("%RDA"), for an answer read with the label protocol
 * instead of this parse: the copy names the column the model's percentages come from. Null with US formats only,
 * without one panel, or when no header names a percentage column.
 */
export function printedPercentHeader(
  panels: readonly Pick<PrintedPanel, "columnHeaders" | "rows">[],
  formats: readonly LabelFormatId[],
): string | null {
  const [panel, ...others] = panels;
  if (!panel || others.length || isUsOnlyFormats(formats)) {
    return null;
  }
  return headedColumns(sideBySide(panel).columnHeaders, formats)?.dailyValueHeading ?? null;
}

/** The read so far: the headed columns' printed headers and the serving lines, kept as rows unless the format's. */
function servingRead(
  servingLines: readonly string[],
  headers: HeadedColumns | null,
  formats: readonly LabelFormatId[],
): FormatPanel {
  const read: FormatPanel = {
    rows: [],
    servingSize: null,
    servingsPerContainer: null,
    amountHeading: headers?.amountHeading ?? null,
    dailyValueHeading: headers?.dailyValueHeading ?? null,
  };
  for (const text of servingLines) {
    if (!formatLine(read, [text], formats)) {
      read.rows.push({ cells: [text], indent: 0, bold: false, table: 0 });
    }
  }
  return read;
}

function preparedFrom(panel: PrintedPanel, formats: readonly LabelFormatId[]): boolean {
  const lines = [
    panel.heading ?? "",
    ...panel.servingLines,
    ...panel.rows.map((row) => row.cells[0] ?? ""),
  ];
  return lines.some((line) => matchesAny(line, formatRules(formats, "preparedFrom")));
}

/** A table row for the parser, with its headed cells placed; null for a line the format consumes. */
function placedRow(
  read: FormatPanel,
  row: PrintedPanel["rows"][number],
  at: { formats: readonly LabelFormatId[]; headers: HeadedColumns | null; width: number },
): TranscriptRow | "unaligned" | null {
  if (formatLine(read, row.cells, at.formats) || headerRow(row.cells, at.formats)) {
    return null;
  }
  if (!at.headers) {
    return { ...row, table: 0 };
  }
  const columns = rowColumns(row.cells, at.width, at.headers);
  return columns ? { ...row, table: 0, columns } : "unaligned";
}

interface HeadedColumns {
  amountAt: number | null;
  dvAt: number | null;
  amountHeading: string | null;
  dailyValueHeading: string | null;
}

/**
 * The headed amount column (per serving, else the fixed-basis one) and the first percentage column, when the printed
 * headers name a column only a non-US format knows; null leaves each cell to be read by its own text.
 */
function headedColumns(
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
  return { amountAt, dvAt, amountHeading: text(amountAt), dailyValueHeading: text(dvAt) };
}

/** A heading, serving or pack line of the format; serving and pack values are kept as printed. */
function formatLine(
  read: FormatPanel,
  cells: readonly string[],
  formats: readonly LabelFormatId[],
): boolean {
  const [name = "", ...values] = cells;
  const text = name.trim();
  if (matchesAny(text, formatRules(formats, "skip"))) {
    return true;
  }
  const serving = firstMatch(text, formatRules(formats, "servingFor"));
  if (serving) {
    read.servingSize ??= printedValue(serving[1]);
    read.servingsPerContainer ??= printedValue(serving[2]);
    return true;
  }
  const servings = firstMatch(text, formatRules(formats, "servings"));
  if (servings) {
    read.servingsPerContainer ??= printedValue(servings[1] || values.find(Boolean));
  }
  return !!servings;
}

const printedValue = (text: string | undefined) => text?.trim() || null;

/** A name-only line continuing the row above ("(Magnesium bisglycinate buffered …)") joins that row's name. */
function continues(
  read: FormatPanel,
  row: PrintedPanel["rows"][number],
  formats: readonly LabelFormatId[],
): boolean {
  const [name = "", ...values] = row.cells;
  const above = read.rows.at(-1);
  if (
    !above ||
    values.some((cell) => cell.trim()) ||
    !matchesAny(name, formatRules(formats, "continuation"))
  ) {
    return false;
  }
  above.cells = [`${above.cells[0] ?? ""} ${name.trim()}`.trim(), ...above.cells.slice(1)];
  return true;
}

/** A row printing only column names ("Nutrients | Qty./Serving | %RDA"). */
function headerRow(cells: readonly string[], formats: readonly LabelFormatId[]): boolean {
  const printed = cells.map((cell) => cell.trim()).filter(Boolean);
  const names = formatRules(formats, "headerCells");
  return (
    printed.length > 0 &&
    printed.every((cell) => matchesAny(cell, names) || columnRole(cell, formats) !== null) &&
    printed.some((cell) => columnRole(cell, formats) !== null)
  );
}

/**
 * Value-cell positions of the headed columns in this row. The headers either include the name column's or not; a
 * row of the name alone (a group heading) has no values. Any other width cannot be placed under its headers.
 */
function rowColumns(
  cells: readonly string[],
  headers: number,
  at: Pick<HeadedColumns, "amountAt" | "dvAt">,
): TranscriptRow["columns"] | null {
  const values = cells.length - 1;
  if (values === 0) {
    return { amount: null, dailyValue: null };
  }
  const shift = headers - values;
  if (shift !== 0 && shift !== 1) {
    return null;
  }
  const place = (header: number | null) =>
    header === null || header - shift < 0 ? null : header - shift;
  return { amount: place(at.amountAt), dailyValue: place(at.dvAt) };
}

const matchesAny = (text: string, rules: readonly RegExp[]) =>
  rules.some((rule) => rule.test(text.trim()));
const firstMatch = (text: string, rules: readonly RegExp[]) =>
  rules.map((rule) => rule.exec(text)).find(Boolean) ?? null;
