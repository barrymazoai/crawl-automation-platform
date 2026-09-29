import type { Span } from "./evidence-lines.js";

const printedCharacter = /[\p{L}\p{N}]/u;

/** Whether every letter and digit in `range` sits inside one of the quoted spans. */
export function coversEveryPrintedCharacter(text: string, range: Span, quotes: readonly Span[]) {
  const mask = new Uint8Array(range.end - range.start);
  for (const quote of quotes) {
    mask.fill(1, quote.start - range.start, quote.end - range.start);
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
