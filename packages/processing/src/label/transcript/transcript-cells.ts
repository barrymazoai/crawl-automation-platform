import type { TranscriptRow } from "./html-transcript.js";

const UNIT =
  "mcg|µg|μg|ug|mg|g|kg|iu|i\\.u\\.|ml|cfu|afu|billion(?:\\s+cfu)?|million(?:\\s+cfu)?|kcal|calories?|[0-9]*x|[0-9]*c|ch|hpus?";
/** A printed amount: number + unit (+ DFE/RAE), or a bare number; never a percentage. */
const AMOUNT = new RegExp(
  `^(?:<\\s*)?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:${UNIT})?(?:\\s*(?:dfe|rae|nfe|ate))?\\b(?!\\s*%).*$`,
  "i",
);
const DAILY_VALUE = /^[<]?\s*\d[\d,.]*\s*%\s*[*†‡]*$|^[*†‡]+$/;
const NONE = /^(?:--|—|–|-|\*+|†+|‡+|n\/a)?$/i;
const SERVING_SIZE = /^serving\s*size\s*:?\s*(.*)$/i;
const SERVINGS = /^servings?\s*per\s*container\s*:?\s*(.*)$/i;
const SKIP =
  /^(?:supplement|nutrition|drug)\s+facts$|^amount\s*(?:per|\/)\s*serving$|^%\s*(?:dv|daily\s*value)|daily\s+value|not\s+established|calorie\s+diet|^\$\s*\d/i;
const GROUP_WORD = /\b(?:blend|complex|matrix|formula|proprietary|system)\b/i;
const IN_NAME_SUGARS = /^includes\s+(\d[\d.]*\s*(?:g|mg))\s+added\s+sugars/i;
/** "Total Carbohydrate <1g" over an amount cell printing a bare "0": the name cell carries the dose. */
const TRAILING_DOSE = /^(.*\S)\s+(<?\s*\d[\d,.]*\s*(?:mcg|µg|mg|g|iu))$/i;
const BARE_NUMBER = /^\d+$/;
/** "240 mcg Folic Acid": a sub-line printing its dose before the name, with no amount cell. */
const LEADING_DOSE = /^\(?(\d[\d,.]*\s*(?:mcg|µg|mg|g|iu))\s+([a-z][^()]*?)\)?$/i;

/** One printed row read into its parts: name, value cells and what the row prints about itself. */
export interface Cells {
  raw: TranscriptRow;
  nameCell: string;
  name: string;
  amount: string | null;
  dailyValue: string | null;
  dvMarker: string | null;
  /** A "--" printed in the amount column of a row without an amount. */
  amountMarker: string | null;
  endsWithColon: boolean;
  groupWord: boolean;
  valuesBlank: boolean;
}

/** A Serving Size / Servings Per Container row and its printed value (in the same cell or the next one). */
export function servingLine(
  raw: TranscriptRow,
): { field: "servingSize" | "servingsPerContainer"; value: string | null } | null {
  const [nameCell = "", ...values] = raw.cells;
  const size = SERVING_SIZE.exec(nameCell);
  const servings = size ? null : SERVINGS.exec(nameCell);
  const match = size ?? servings;
  if (!match) {
    return null;
  }
  const value = (match[1] || values.find(Boolean) || "").trim() || null;
  return { field: size ? "servingSize" : "servingsPerContainer", value };
}

/** The row's cells, or null for a heading, column header, footnote or price line. */
export function readCells(raw: TranscriptRow): Cells | null {
  const [nameCell = "", ...values] = raw.cells;
  if (!nameCell || skipped(raw, values)) {
    return null;
  }
  const value = valueCells(values);
  const inName = doseInName(nameCell, value.amountCell);
  return {
    raw,
    nameCell,
    name: (inName?.name ?? nameCell).replace(/:\s*$/, "").trim(),
    amount: inName?.amount ?? printed(value.amountCell) ?? null,
    dailyValue: printed(value.dvCell),
    dvMarker: marker(value.dvCell),
    amountMarker: value.amountMarker,
    endsWithColon: /:\s*$/.test(nameCell),
    groupWord: GROUP_WORD.test(nameCell),
    valuesBlank: values.every((cell) => !cell || NONE.test(cell) || AMOUNT.test(cell)),
  };
}

const isMarker = (value: string) => !!value.trim() && NONE.test(value);

/** Which value cell is the amount and which the %DV, and the amount column's own "--" when it prints none. */
function valueCells(values: string[]) {
  const amountAt = values.findIndex((value) => AMOUNT.test(value) && !DAILY_VALUE.test(value));
  const amountCell = values[amountAt];
  // Without a printed %DV, the last value cell printing only "--"/"**" is the %DV column's own marker.
  let dvAt = values.findIndex((value, at) => at !== amountAt && DAILY_VALUE.test(value));
  if (dvAt < 0) {
    dvAt = values.findLastIndex(isMarker);
  }
  const amountMarker = amountCell
    ? null
    : marker(values.find((value, at) => at !== dvAt && isMarker(value)));
  return { amountCell, dvCell: values[dvAt], amountMarker };
}

/** A dose the name cell prints itself: "Total Carbohydrate <1g", "240 mcg Folic Acid", "Includes 4 g Added Sugars". */
function doseInName(
  nameCell: string,
  amountCell: string | undefined,
): { name: string; amount: string } | null {
  if (amountCell && BARE_NUMBER.test(amountCell)) {
    return split(TRAILING_DOSE.exec(nameCell), 1, 2);
  }
  if (printed(amountCell)) {
    return null;
  }
  const sugars = IN_NAME_SUGARS.exec(nameCell)?.[1];
  return (
    split(LEADING_DOSE.exec(nameCell), 2, 1) ?? (sugars ? { name: nameCell, amount: sugars } : null)
  );
}

function split(
  match: RegExpExecArray | null,
  nameAt: number,
  amountAt: number,
): { name: string; amount: string } | null {
  const name = match?.[nameAt];
  const amount = match?.[amountAt];
  return name && amount ? { name, amount } : null;
}

function skipped(raw: TranscriptRow, values: string[]): boolean {
  const [nameCell = ""] = raw.cells;
  const joined = raw.cells.filter(Boolean).join(" ");
  return SKIP.test(nameCell) || (SKIP.test(joined) && !values.some((value) => AMOUNT.test(value)));
}

/** A cell's printed value; "--", "**", "†" and blanks print none. */
function printed(cell: string | undefined): string | null {
  return cell && !NONE.test(cell) ? cell : null;
}

/** A cell printed only to say "nothing here", quoted as printed. */
function marker(cell: string | undefined): string | null {
  return cell?.trim() && NONE.test(cell) ? cell.trim() : null;
}
