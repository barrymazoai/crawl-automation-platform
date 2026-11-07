import type { LabelFormatId, LabelImageCandidate } from "@crawl-automation/v3-contracts";
import type { OcrReading } from "../../keywords/ocr-text.js";
import {
  DOSE,
  NAME_PREFIX,
  firstDose,
  letters as lettersOf,
  squashAmount,
  type AmountPositions,
} from "../../vision/protocol/label-amount-position.js";

/**
 * Owner 2026-11-07 (KAN-243, Kapiva Shilajit Gold Resin on amazon.in): an Indian composition is often printed as one
 * paragraph ("Each 1g contains: Shilajit (Asphaltum) Exd. 333.33mg, Coffee Extract (Coffea arabica) Sd. 200mg, …").
 * The OCR's lines then hold several ingredients each, so an amount sits on "another row" of the table check. For a
 * composition list (a copy whose amount column has no printed header), an amount is printed where the first dose
 * after the ingredient's name is that amount, on the name's own line or the next, with no other copied ingredient
 * between them; the name must be printed once. Anything else keeps the table check's result.
 */
export function proseAmounts(
  candidate: LabelImageCandidate,
  ocr: OcrReading,
  at: { positions: AmountPositions; formats: readonly LabelFormatId[] },
): AmountPositions {
  const { positions } = at;
  const column = candidate.formula?.columns[0];
  if (!at.formats.includes("in-composition/2") || !column || column.heading) {
    return positions;
  }
  const text = ocr.lines.map((line) => line.text).join("\n");
  const prose: Prose = {
    rows: column.rows,
    names: column.rows.map((row) => lettersOf(row.name.text).slice(0, NAME_PREFIX)),
    text,
    ...letterIndex(text),
  };
  const confirmed = new Set(positions.confirmed);
  const misplaced = positions.misplaced.filter((index) => !printedAfterName(prose, index));
  column.rows.forEach((row, index) => {
    if (row.amount && !confirmed.has(index) && printedAfterName(prose, index)) {
      confirmed.add(index);
    }
  });
  return { confirmed: [...confirmed].sort((first, second) => first - second), misplaced };
}

interface Prose {
  rows: NonNullable<LabelImageCandidate["formula"]>["columns"][number]["rows"];
  names: string[];
  text: string;
  letters: string;
  at: number[];
}

/** Where the row's name ends in the text, when the name is printed once and long enough to find. */
function nameEnd(prose: Prose, index: number): number | null {
  const name = prose.names[index] ?? "";
  const first = prose.letters.indexOf(name);
  if (name.length < NAME_PREFIX || first < 0 || prose.letters.includes(name, first + 1)) {
    return null;
  }
  return (prose.at[first + name.length - 1] ?? prose.text.length) + 1;
}

/** The first dose after the row's once-printed name is its amount, on that line or the next, no ingredient between. */
function printedAfterName(prose: Prose, index: number): boolean {
  const printed = prose.rows[index]?.amount?.text;
  const amount = printed ? firstDose(printed) : null;
  const from = nameEnd(prose, index);
  const next = from === null ? null : new RegExp(DOSE.source, "i").exec(prose.text.slice(from));
  if (!amount || from === null || !next) {
    return false;
  }
  const between = prose.text.slice(from, from + next.index);
  return squashAmount(next[0]) === amount && sameStretch(prose, index, between);
}

/** At most one line break, and no other copied ingredient, between a name and its amount. */
function sameStretch(prose: Prose, index: number, between: string): boolean {
  const crossed = prose.names.some(
    (other, at) =>
      at !== index && other.length >= NAME_PREFIX && lettersOf(between).includes(other),
  );
  return (between.match(/\n/g) ?? []).length <= 1 && !crossed;
}

/** The text's letters and digits, with where each one is in the text. */
function letterIndex(text: string): { letters: string; at: number[] } {
  let letters = "";
  const at: number[] = [];
  for (let index = 0; index < text.length; index++) {
    for (const each of lettersOf(text.charAt(index))) {
      letters += each;
      at.push(index);
    }
  }
  return { letters, at };
}
