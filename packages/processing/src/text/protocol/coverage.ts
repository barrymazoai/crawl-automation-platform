import type { Span } from "./evidence-lines.js";

const printedCharacter = /[\p{L}\p{N}]/u;

/** Whether every letter and digit in `range` sits inside one of the quoted spans. */
export function coversEveryPrintedCharacter(text: string, range: Span, quotes: readonly Span[]) {
  const mask = new Uint8Array(range.end - range.start);
  for (const quote of quotes) {
    mask.fill(1, Math.max(0, quote.start - range.start), Math.max(0, quote.end - range.start));
  }
  let offset = 0;
  for (const character of text.slice(range.start, range.end)) {
    if (!mask[offset] && printedCharacter.test(character)) {
      return false;
    }
    offset += character.length;
  }
  return true;
}

/** Unquoted intervals, used to recognize whole structural sentences without swallowing data. */
export function uncoveredSpans(range: Span, quotes: readonly Span[]): Span[] {
  let start = range.start;
  const gaps: Span[] = [];
  for (const quote of [...quotes].sort((left, right) => left.start - right.start)) {
    if (quote.start > start) {
      gaps.push({ start, end: Math.min(quote.start, range.end) });
    }
    start = Math.max(start, quote.end);
  }
  if (start < range.end) {
    gaps.push({ start, end: range.end });
  }
  return gaps.filter((gap) => gap.start < gap.end);
}
