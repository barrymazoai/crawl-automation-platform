import type { Span } from "./evidence-lines.js";

const escapeToken = (token: string) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordCharacter = /[\p{L}\p{N}]/u;

/** A quote's words as a pattern; whitespace between words may differ from the printed text. */
export function quotePattern(words: readonly string[]): string {
  return words.map(escapeToken).join("\\s+");
}

/** The quote's words with `enclosed` (a row's own amount) inside, at every inner word boundary. */
export function enclosingPatterns(words: readonly string[], enclosed: string): string[] {
  const inner = enclosed.trim().split(/\s+/u);
  return words
    .slice(1)
    .map((_, index) =>
      quotePattern([...words.slice(0, index + 1), ...inner, ...words.slice(index + 1)]),
    );
}

/** Every place `pattern` occurs inside `window`, as absolute offsets (`window` starts at `offset`). */
export function occurrences(window: string, offset: number, pattern: string): Span[] {
  return [...window.matchAll(new RegExp(pattern, "gu"))].map((match) => ({
    start: offset + (match.index ?? 0),
    end: offset + (match.index ?? 0) + match[0].length,
  }));
}

/** The occurrence neither starts nor ends inside a longer word. */
export function isWholeWords(text: string, span: Span): boolean {
  const startsInside =
    wordCharacter.test(text[span.start - 1] ?? "") && wordCharacter.test(text[span.start] ?? "");
  const endsInside =
    wordCharacter.test(text[span.end] ?? "") && wordCharacter.test(text[span.end - 1] ?? "");
  return !startsInside && !endsInside;
}

/** Between list separators, or a line or heading edge, on both sides: `, Chicken,` but not `Chicken Fat`. */
export function isWholeListEntry(text: string, span: Span): boolean {
  const before = text.slice(0, span.start).replace(/[ \t]+$/u, "");
  const after = text.slice(span.end).replace(/^[ \t]+/u, "");
  return (!before || /[,;:(\n]$/u.test(before)) && (!after || /^[,;.)\n]/u.test(after));
}

/** The two spans share at least one character. */
export function overlaps(first: Span, second: Span): boolean {
  return first.start < second.end && second.start < first.end;
}
