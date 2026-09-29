import type { Span } from "./evidence-lines.js";

/** The range is a non-empty, whole-number slice of a text of `length` characters. */
export function isWithinText(range: Span, length: number): boolean {
  const whole = Number.isInteger(range.start) && Number.isInteger(range.end);
  return whole && range.start >= 0 && range.end <= length && range.end > range.start;
}

/** Either end of the range would split a character that takes two UTF-16 units (an "astral" character). */
export function splitsCharacter(text: string, range: Span): boolean {
  return [range.start, range.end].some(
    (offset) =>
      offset > 0 &&
      /[\uD800-\uDBFF]/.test(text[offset - 1] ?? "") &&
      /[\uDC00-\uDFFF]/.test(text[offset] ?? ""),
  );
}
