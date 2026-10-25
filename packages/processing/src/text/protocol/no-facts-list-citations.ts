import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { completeIngredientItem, ingredientGap } from "./ingredient-boundaries.js";

type Quote = { text: string; start: number; end: number };
type Other = NonNullable<LabelTextCandidate["otherIngredients"]>;

export function secondHeading(heading: Quote, first: Quote, text: string): Quote | null {
  const gap = text.slice(heading.end, first.start);
  const match = /^\s*(Ingredients:?)\s*$/iu.exec(gap);
  const label = match?.[1];
  if (!label) {
    return null;
  }
  const start = heading.end + gap.indexOf(label);
  return { text: label, start, end: start + label.length };
}

export function completeList(
  other: Other,
  text: string,
  range: { start: number; end: number },
): boolean {
  const { heading, items } = other;
  const first = items[0],
    last = items.at(-1);
  if (!first || !last) {
    return false;
  }
  if (
    heading.start < range.start ||
    last.end > range.end ||
    !/^\s*:?\s*$/u.test(text.slice(heading.end, first.start))
  ) {
    return false;
  }
  if (!listItemsAreCited(items, text)) {
    return false;
  }
  // The last citation must reach the end of its printed list line; no uncited trailing item can be dropped.
  return /^\s*\.?\s*$/u.test(text.slice(last.end).split(/\r?\n/u, 1)[0] ?? "");
}

function listItemsAreCited(items: Other["items"], text: string): boolean {
  for (const [index, item] of items.entries()) {
    if (
      text.slice(item.start, item.end) !== item.text ||
      !completeIngredientItem(item.text, items.length > 1)
    ) {
      return false;
    }
    const previous = items[index - 1];
    if (previous && !ingredientGap(text, previous, item)) {
      return false;
    }
  }
  return true;
}

export function wholeLine(text: string, quote: Quote): boolean {
  const start = text.lastIndexOf("\n", quote.start - 1) + 1;
  const lineEnd = text.indexOf("\n", quote.end);
  const end = lineEnd < 0 ? text.length : lineEnd;
  return /^\s*$/u.test(text.slice(start, quote.start)) && /^\s*$/u.test(text.slice(quote.end, end));
}

export function titleLine(text: string, quote: Quote): boolean {
  const start = text.lastIndexOf("\n", quote.start - 1) + 1;
  const lineEnd = text.indexOf("\n", quote.end);
  const end = lineEnd < 0 ? text.length : lineEnd;
  return (
    /^\s*$/u.test(text.slice(start, quote.start)) &&
    /\bFormula$/iu.test(quote.text.trim()) &&
    /^\t\S/u.test(text.slice(quote.end, end))
  );
}
