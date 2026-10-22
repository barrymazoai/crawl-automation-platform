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
    } else if (/[,;]/.test(character) && stack.length === 0 && !isNumericLocantComma(text, index)) {
      separators.push(index);
    }
  }
  return stack.length ? null : separators;
}

function isNumericLocantComma(text: string, index: number): boolean {
  return (
    text.charAt(index) === "," &&
    /\d/.test(text.charAt(index - 1)) &&
    /\d/.test(text.charAt(index + 1))
  );
}

/** A comma after initial quality modifiers does not name another ingredient ("Wild, high-mountain, organic sage"). */
export function completeIngredientItem(text: string, allowPrintedMismatch = false): boolean {
  const separators = topLevelSeparators(text);
  return (
    (separators !== null || (allowPrintedMismatch && malformedSingleItem(text))) &&
    !/^\s*[([]/.test(text) &&
    !/-\s*$/.test(text) &&
    (compositeBlendItem(text, separators) ||
      (separators ?? []).every(
        (index) =>
          text[index] === "," &&
          /^(?:(?:raw|wild|organic|(?:high|low)-[a-z]+|[a-z]+-grown)\s*,?\s*)+$/i.test(
            text.slice(0, index),
          ),
      ))
  );
}

/** A named blend may print its component list after a colon as one quoted item. */
function compositeBlendItem(text: string, separators: number[] | null): boolean {
  if (!separators?.length) {
    return false;
  }
  const colon = text.indexOf(":");
  return (
    colon > 0 &&
    /\b(?:blend|complex)\b/i.test(text.slice(0, colon)) &&
    separators.every((index) => index > colon && text[index] === ",") &&
    text
      .slice(text.lastIndexOf(":") + 1)
      .split(",")
      .every((part) => !!part.trim())
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

// "Hydroxypropyl Methylcellulose. Contains <2% of: Magnesium Stearate" (Swanson), "Water, Less than 2% of:
// Pectin" (Costco) or "Water, Contains 2 percent or less of (Citric Acid, …)" (Natrol gummies, 2026-10-21) continues
// the same list; the bracket that opens the minor-ingredient group is part of the separator.
const MINOR_HEADING = String.raw`(?:contains\s+)?(?:(?:<|less\s+than)\s*\d+(?:\.\d+)?\s*(?:%|percent)|\d+(?:\.\d+)?\s*(?:%|percent)\s+or\s+less)\s+of(?:\s+(?:each\s+of\s+)?the\s+following)?\s*:?`;
const MINOR_INGREDIENTS = new RegExp(
  String.raw`^\s*(?:[,;.]\s*){0,2}${MINOR_HEADING}[\s,;(]*$`,
  "i",
);

export function minorIngredientHeading(value: string): boolean {
  return new RegExp(String.raw`^\s*${MINOR_HEADING}\s*$`, "i").test(value);
}

const SUBLIST_HEADING = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}:$/;
const NON_INGREDIENT_HEADING =
  /^(?:Contains|Manufactured|Processed|Directions|Warnings|Uses|Other Ingredients)\b/i;

function citedSublistHeading(
  gap: string,
  context: { previous: string; gapStart: number; headings: readonly Quote[] },
): boolean {
  const blend = /\b(?:blend|complex)\*?$/i.test(context.previous.trim());
  const match =
    /^\.\s+([^\n:]+:)\s*$/.exec(gap) ?? (blend ? /^:\s+([^\n:]+:)\s*$/.exec(gap) : null);
  const heading = match?.[1];
  if (
    !heading ||
    (!blend && !SUBLIST_HEADING.test(heading)) ||
    NON_INGREDIENT_HEADING.test(heading)
  ) {
    return false;
  }
  const start = context.gapStart + gap.indexOf(heading);
  return context.headings.some(
    (quote) => quote.start === start && quote.end === start + heading.length,
  );
}

/** The quoted blend item can itself end with the heading for its following component items. */
function inlineBlendSublistStart(previous: string, gap: string): boolean {
  if (!/^\s+$/.test(gap)) {
    return false;
  }
  const match = /^[^:]+\b(?:blend|complex)\*?\s*:\s*([^:]+:)$/i.exec(previous.trim());
  const heading = match?.[1];
  return (
    !!heading &&
    /^[A-Z][\p{L}\p{M}\p{N}\s&'’/-]*:$/u.test(heading) &&
    !NON_INGREDIENT_HEADING.test(heading)
  );
}

function listSeparator(
  previous: string,
  gap: string,
  context: { start: number; headings: readonly Quote[] },
): boolean {
  return (
    /^\s*(?:(?:[,;.|‚]\s*(?:and\s+)?)|and\s+|in\s+a\s+base\s+of\s+)$/i.test(gap) ||
    (/\.\s*$/.test(previous) && /^\s+$/.test(gap)) ||
    MINOR_INGREDIENTS.test(gap) ||
    inlineBlendSublistStart(previous, gap) ||
    citedSublistHeading(gap, { previous, gapStart: context.start, headings: context.headings })
  );
}

/** Separators must contain no skipped words; conjunctions are used only between anchored items. */
export function ingredientGap(
  text: string,
  previous: Quote,
  target: Quote | { next: Quote; headings: readonly Quote[] },
): Span | null {
  const next = "next" in target ? target.next : target;
  const headings = "next" in target ? target.headings : [];
  if (
    previous.end > next.start ||
    !completeIngredientItem(previous.text, true) ||
    !completeIngredientItem(next.text, true)
  ) {
    return null;
  }
  const gap = text.slice(previous.end, next.start);
  const separated = listSeparator(previous.text, gap, {
    start: previous.end,
    headings,
  });
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
