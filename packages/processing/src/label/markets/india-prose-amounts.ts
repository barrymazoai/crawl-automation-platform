import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import type { OcrReading } from "../../keywords/ocr-text.js";
import type { AmountPositions } from "../../vision/protocol/label-amount-position.js";
import { squashAmount } from "../../vision/protocol/label-amount-position.js";

/** A printed dose with its unit, as the position check reads it. */
const DOSE =
  /(?<![\d.])\d[\d,]*(?:\.\d+)?\s*(?:mcg|µg|μg|ug|mg|kg|g|iu|i\.u\.|ml|kcal|cfu|billion|million)(?![a-z])/gi;
/** Enough of a name to find it in the printed text. */
const NAME_PREFIX = 12;

/**
 * Owner 2026-11-07 (KAN-243, Kapiva Shilajit Gold Resin on amazon.in): an Indian composition is often printed as one
 * paragraph ("Each 1g contains: Shilajit (Asphaltum) Exd. 333.33mg, Coffee Extract (Coffea arabica) Sd. 200mg, …").
 * The OCR's lines then hold several ingredients each, so an amount sits on "another row" of the table check. In such
 * text an amount is printed where the first dose after the ingredient's name is that amount; the name must be printed
 * once. Rows this confirms count as confirmed; anything else keeps the table check's result.
 */
export function proseAmounts(
  candidate: LabelImageCandidate,
  ocr: OcrReading,
  positions: AmountPositions,
): AmountPositions {
  const rows = candidate.formula?.columns[0]?.rows ?? [];
  const text = ocr.lines.map((line) => line.text).join(" ");
  const { letters, at } = letterIndex(text);
  const read = (index: number): boolean => {
    const row = rows[index];
    const amount = row?.amount ? firstDose(row.amount.text) : null;
    const name = row ? lettersOf(row.name.text).slice(0, NAME_PREFIX) : "";
    if (!amount || name.length < NAME_PREFIX) {
      return false;
    }
    const first = letters.indexOf(name);
    if (first < 0 || letters.indexOf(name, first + 1) >= 0) {
      return false;
    }
    const after = text.slice(at[first + name.length - 1] ?? text.length);
    const next = after.match(new RegExp(DOSE.source, "i"));
    return !!next && squashAmount(next[0]) === amount;
  };
  const confirmed = new Set(positions.confirmed);
  const misplaced = positions.misplaced.filter((index) => !read(index));
  rows.forEach((row, index) => {
    if (row.amount && !confirmed.has(index) && read(index)) {
      confirmed.add(index);
    }
  });
  return { confirmed: [...confirmed].sort((first, second) => first - second), misplaced };
}

function firstDose(text: string): string | null {
  const match = text.match(new RegExp(DOSE.source, "i"));
  return match ? squashAmount(match[0]) : null;
}

const lettersOf = (text: string) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

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
