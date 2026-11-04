import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import type { OcrLine, OcrReading } from "../../keywords/ocr-text.js";

type Row = NonNullable<LabelImageCandidate["formula"]>["columns"][number]["rows"][number];

/** Units the OCR and the model may print differently for the same amount. */
export const squashAmount = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[µμ]g|\bug\b/g, "mcg")
    .replace(/[\s,]/g, "");

/** A printed dose with its unit ("1,125 mcg", "0.5 g", "400 IU"); never a %DV or a bare number. */
const DOSE =
  /(?<![\d.])\d[\d,]*(?:\.\d+)?\s*(?:mcg|µg|μg|ug|mg|kg|g|iu|i\.u\.|ml|kcal|cfu|billion|million)(?![a-z])/gi;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const letters = (text: string) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
/** Enough of a row's name to find its printed line, short enough to survive a wrapped line. */
const NAME_PREFIX = 12;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
interface Placed {
  line: OcrLine & { polygon: [number, number][] };
  box: Box;
}
interface Dose {
  key: string;
  x: number;
  y: number;
}

/** What the OCR's positions say about each printed amount of the copied panel. */
export interface AmountPositions {
  /** Rows whose amount the OCR prints on that row's own printed line(s). */
  confirmed: number[];
  /**
   * Rows whose printed line(s) carry another amount, one the copy gave to a different row: the copy put amounts on the
   * wrong rows. Never confirmed by a re-read (a re-read repeats such a misreading); the image is read as before.
   */
  misplaced: number[];
}

/**
 * Owner 2026-11-04 (a Facts column printed half a row off, where the copy and its re-read both shifted amounts by one
 * row): an amount counts as printed only when the OCR prints it inside its row's band (from the row's name line down to
 * the next row's name line in the same column, and right of the name). Rows the OCR cannot place stay unconfirmed and
 * may be re-read. An OCR result without line positions confirms nothing.
 */
export function amountPositions(candidate: LabelImageCandidate, ocr: OcrReading): AmountPositions {
  const rows = candidate.formula?.columns[0]?.rows ?? [];
  const placed = placeNames(rows, ocr.lines);
  const doses = ocr.lines.flatMap((line) =>
    line.polygon ? lineDoses(line.text, box(line.polygon)) : [],
  );
  const copied = copiedDoses(rows);
  const result: AmountPositions = { confirmed: [], misplaced: [] };
  rows.forEach((row, index) => {
    const at = placed.get(index);
    if (!row.amount || !at) {
      return;
    }
    const inBand = (x: number, y: number) =>
      y >= at.band.top && y < at.band.bottom && x >= at.band.left && x < at.band.right;
    const key = firstDose(row.amount.text);
    if (!key) {
      if (bareNumberInBand(row.amount.text, ocr.lines, inBand)) {
        result.confirmed.push(index);
      }
      return;
    }
    const here = doses.filter((dose) => inBand(dose.x, dose.y));
    if (here.some((dose) => dose.key === key)) {
      result.confirmed.push(index);
    } else if (here.some((dose) => (copied.get(dose.key) ?? []).some((other) => other !== index))) {
      result.misplaced.push(index);
    }
  });
  return result;
}

/** Which rows the copy gave each dose to. */
function copiedDoses(rows: readonly Row[]): Map<string, number[]> {
  const copied = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const key = row.amount ? firstDose(row.amount.text) : null;
    if (key) {
      copied.set(key, [...(copied.get(key) ?? []), index]);
    }
  });
  return copied;
}

/** A unitless amount (Calories "130"): the number printed on the row's own lines. */
function bareNumberInBand(
  amount: string,
  lines: readonly OcrLine[],
  inBand: (x: number, y: number) => boolean,
): boolean {
  const bare = new RegExp(`(?<![0-9.])${escape(squashAmount(amount))}(?![0-9.])`);
  return lines.some(
    (line) => line.polygon && inBandLine(line, inBand) && bare.test(squashAmount(line.text)),
  );
}

function inBandLine(line: OcrLine, inBand: (x: number, y: number) => boolean): boolean {
  const at = box(line.polygon ?? []);
  return inBand(at.right, (at.top + at.bottom) / 2);
}

/** The first dose an amount prints, squashed ("10 mcg (400 IU)" is "10mcg"). */
function firstDose(text: string): string | null {
  const match = text.match(new RegExp(DOSE.source, "i"));
  return match ? squashAmount(match[0]) : null;
}

function box(polygon: readonly (readonly [number, number])[]): Box {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

/** Each dose a line prints, placed where it sits along the line. */
function lineDoses(text: string, at: Box): Dose[] {
  const width = at.right - at.left;
  return [...text.matchAll(DOSE)].map((match) => ({
    key: squashAmount(match[0]),
    x: at.left + (width * ((match.index ?? 0) + match[0].length / 2)) / Math.max(1, text.length),
    y: (at.top + at.bottom) / 2,
  }));
}

/** Each copied row's printed name line, with the band its own values sit in. */
function placeNames(rows: readonly Row[], lines: readonly OcrLine[]) {
  const found = nameLines(rows, lines);
  const named = [...found.values()];
  const bands = new Map<number, { band: Box }>();
  for (const [index, own] of found) {
    bands.set(index, { band: band(own, named) });
  }
  return bands;
}

/** The first unused printed line, top down, that starts with each row's name. */
function nameLines(rows: readonly Row[], lines: readonly OcrLine[]): Map<number, Placed> {
  const positioned = lines.flatMap((line): Placed[] =>
    line.polygon?.length === 4 ? [{ line: line as Placed["line"], box: box(line.polygon) }] : [],
  );
  const used = new Set<Placed>();
  const found = new Map<number, Placed>();
  rows.forEach((row, index) => {
    const name = letters(row.name.text).slice(0, NAME_PREFIX);
    if (name.length < 3) {
      return;
    }
    const match = positioned
      .filter((candidate) => !used.has(candidate) && namesLine(name, candidate.line.text))
      .sort((upper, lower) => upper.box.top - lower.box.top)[0];
    if (match) {
      used.add(match);
      found.set(index, match);
    }
  });
  return found;
}

/** From the row's name line down to the next name line in its column, and left of the next column's names. */
function band(own: Placed, named: readonly Placed[]): Box {
  const height = Math.max(1, own.box.bottom - own.box.top);
  const below = named
    .filter(
      (other) => other !== own && other.box.left < own.box.right && other.box.right > own.box.left,
    )
    .map((other) => other.box.top)
    .filter((top) => top > own.box.top + height / 3);
  const nextColumn = named
    .filter((other) => other.box.left > own.box.right)
    .map((other) => other.box.left);
  return {
    left: own.box.left,
    right: nextColumn.length ? Math.min(...nextColumn) : Number.POSITIVE_INFINITY,
    top: own.box.top,
    bottom: below.length ? Math.min(...below) : own.box.bottom + 2 * height,
  };
}

/** A printed line that starts with the row's name (or is the start of a wrapped name). */
function namesLine(name: string, text: string): boolean {
  const printed = letters(text);
  return (
    printed.startsWith(name) ||
    (printed.length >= 8 && name.startsWith(printed.slice(0, NAME_PREFIX)))
  );
}
