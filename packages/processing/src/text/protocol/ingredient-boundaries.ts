import type { Quote, Span } from "./evidence-lines.js";

/** Scan only punctuation outside balanced brackets; a wrapped subingredient stays in its item. */
function topLevelSeparators(text: string): number[] | null {
  const stack: string[] = [];
  const closing: Record<string, string> = { "(": ")", "[": "]" };
  const separators: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    const close = closing[character];
    if (close) {
      stack.push(close);
    } else if (character === ")" || character === "]") {
      if (stack.pop() !== character) {
        return null;
      }
    } else if (/[,;]/.test(character) && stack.length === 0) {
      separators.push(index);
    }
  }
  return stack.length ? null : separators;
}

/** A comma after an initial modifier does not name another ingredient ("Raw, wild extract"). */
export function completeIngredientItem(text: string, allowPrintedMismatch = false): boolean {
  const separators = topLevelSeparators(text);
  return (
    (separators !== null || (allowPrintedMismatch && malformedSingleItem(text))) &&
    !/^\s*[([]/.test(text) &&
    !/-\s*$/.test(text) &&
    (separators ?? []).every(
      (index) =>
        text[index] === "," && /^(?:(?:raw|wild|organic)\s*,?\s*)+$/i.test(text.slice(0, index)),
    )
  );
}

/** A cited item can retain its source's broken bracket only when it contains no outer list separator. */
function malformedSingleItem(text: string): boolean {
  const stack: string[] = [];
  let opened = false;
  for (const character of text) {
    if (character === "(" || character === "[") {
      stack.push(character === "(" ? ")" : "]");
      opened = true;
    } else if (character === ")" || character === "]") {
      stack.pop();
    } else if ((character === "," || character === ";") && stack.length === 0) {
      return false;
    }
  }
  return opened;
}

// "Hydroxypropyl Methylcellulose. Contains <2% of: Magnesium Stearate" (Swanson) or "Water, Less than 2% of:
// Pectin" (Costco) continues the same list.
const MINOR_INGREDIENTS =
  /^\s*(?:[,;.]\s*){0,2}(?:contains\s+)?(?:(?:<|less\s+than)\s*2\s*%|2\s*%\s+or\s+less)\s+of(?:\s+(?:each\s+of\s+)?the\s+following)?\s*:?[\s,;]*$/i;

function listSeparator(previous: string, gap: string): boolean {
  return (
    /^\s*(?:(?:[,;.|‚]\s*(?:and\s+)?)|and\s+|in\s+a\s+base\s+of\s+)$/i.test(gap) ||
    (/\.\s*$/.test(previous) && /^\s+$/.test(gap)) ||
    MINOR_INGREDIENTS.test(gap)
  );
}

/** Separators must contain no skipped words; conjunctions are used only between anchored items. */
export function ingredientGap(text: string, previous: Quote, next: Quote): Span | null {
  if (
    previous.end > next.start ||
    !completeIngredientItem(previous.text, true) ||
    !completeIngredientItem(next.text, true)
  ) {
    return null;
  }
  const gap = text.slice(previous.end, next.start);
  const separated = listSeparator(previous.text, gap);
  // This conjunction joins adjectives inside one ingredient name, never two list entries.
  const compound =
    /\bnatural\s*$/i.test(previous.text) &&
    /^\s*and\s*$/i.test(gap) &&
    /^artificial\s+flavou?rs?\b/i.test(next.text);
  return separated && !compound ? { start: previous.end, end: next.start } : null;
}

/** Citation disambiguation uses the same bracket/conjunction vocabulary as list validation. */
export function ingredientEntryEdges(text: string, span: Span): boolean {
  const before = text.slice(0, span.start).replace(/[ \t]+$/u, "");
  const after = text.slice(span.end).replace(/^[ \t]+/u, "");
  return (
    (!before || /[,;:.([\n]$|\band$/iu.test(before)) &&
    (!after || /^[,;.)\]\n]|^and\b/iu.test(after))
  );
}
