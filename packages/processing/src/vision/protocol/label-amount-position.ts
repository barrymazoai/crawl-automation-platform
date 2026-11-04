import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import type { OcrReading } from "../../keywords/ocr-text.js";
import { visualLines, type Box, type Visual } from "./ocr-visual-lines.js";

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
/** A wrapped first line shorter than this never stands for a name. */
const MIN_WRAPPED = 8;
/** A name this far right of another (share of the panel's width) starts the next printed column. */
const NEXT_COLUMN_SHARE = 0.3;

interface Anchor {
  line: Visual;
  piece: number;
  box: Box;
}
interface Dose {
  key: string;
  x: number;
  y: number;
}
type InBand = (x: number, y: number) => boolean;

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
  const lines = visualLines(ocr.lines);
  const bands = rowBands(rows, lines);
  const doses = lines.flatMap((line) => numbersOn(line, DOSE));
  const copied = copiedDoses(rows);
  const result: AmountPositions = { confirmed: [], misplaced: [] };
  rows.forEach((row, index) => {
    const band = bands.get(index);
    if (!row.amount || !band) {
      return;
    }
    const inBand: InBand = (x, y) =>
      y >= band.top && y < band.bottom && x >= band.left && x < band.right;
    const key = firstDose(row.amount.text);
    if (!key) {
      // A unitless amount (Calories "130"): the number printed in the row's band.
      const bare = new RegExp(`(?<![\\d.])${escape(row.amount.text.trim())}(?![\\d.])`, "g");
      if (lines.some((line) => numbersOn(line, bare).some((dose) => inBand(dose.x, dose.y)))) {
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

/** The first dose an amount prints, squashed ("10 mcg (400 IU)" is "10mcg"). */
function firstDose(text: string): string | null {
  const match = text.match(new RegExp(DOSE.source, "i"));
  return match ? squashAmount(match[0]) : null;
}

/** Each match of a number pattern on a printed line, placed where it sits along the line. */
function numbersOn(line: Visual, pattern: RegExp): Dose[] {
  return [...line.text.matchAll(pattern)].map((match) => ({
    key: squashAmount(match[0]),
    x: line.xs[(match.index ?? 0) + Math.floor(match[0].length / 2)] ?? line.xs.at(-1) ?? 0,
    y: (line.top + line.bottom) / 2,
  }));
}

/** Each copied row's band: from its name down to the next name in its column, left of the next column. */
function rowBands(rows: readonly Row[], lines: readonly Visual[]): Map<number, Box> {
  const anchors = nameAnchors(rows, lines);
  const all = [...anchors.values()];
  const bands = new Map<number, Box>();
  if (!all.length) {
    return bands;
  }
  const width = Math.max(
    1,
    Math.max(...lines.map((line) => line.xs.at(-1) ?? 0)) -
      Math.min(...all.map((anchor) => anchor.box.left)),
  );
  for (const [index, own] of anchors) {
    bands.set(index, band(own, all, width));
  }
  return bands;
}

function band(own: Anchor, all: readonly Anchor[], width: number): Box {
  const height = Math.max(1, own.line.bottom - own.line.top);
  const nextColumn = all
    .filter((other) => other.box.left - own.box.left > NEXT_COLUMN_SHARE * width)
    .map((other) => other.box.left);
  const right = nextColumn.length ? Math.min(...nextColumn) : Number.POSITIVE_INFINITY;
  const below = all
    .filter((other) => other.box.left >= own.box.left - height * 4 && other.box.left < right)
    .map((other) => other.line.top)
    .filter((top) => top > own.line.top + height / 3);
  return {
    left: own.box.left,
    right,
    top: own.line.top,
    bottom: below.length ? Math.min(...below) : own.line.bottom + 2 * height,
  };
}

/** The first unused printed line, top down, where each row's name starts at one of the OCR's pieces. */
function nameAnchors(rows: readonly Row[], lines: readonly Visual[]): Map<number, Anchor> {
  const starts = lines.flatMap((line) =>
    line.pieces.map((piece, at) => ({
      line,
      piece: at,
      box: piece.box,
      text: line.text.slice(piece.at),
    })),
  );
  const used = new Set<(typeof starts)[number]>();
  const found = new Map<number, Anchor>();
  rows.forEach((row, index) => {
    const name = letters(row.name.text).slice(0, NAME_PREFIX);
    if (name.length < 3) {
      return;
    }
    const match = starts
      .filter((start) => !used.has(start) && namesLine(name, start.text))
      .sort((upper, lower) => upper.line.top - lower.line.top)[0];
    if (match) {
      used.add(match);
      found.set(index, match);
    }
  });
  return found;
}

/** A printed line that starts with the row's name (or is the start of a wrapped name). */
function namesLine(name: string, text: string): boolean {
  const printed = letters(text);
  return (
    printed.startsWith(name) ||
    (printed.length >= MIN_WRAPPED && name.startsWith(printed.slice(0, NAME_PREFIX)))
  );
}
