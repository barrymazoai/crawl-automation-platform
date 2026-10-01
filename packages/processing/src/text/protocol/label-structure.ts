import { completeIngredientItem, ingredientGap } from "./ingredient-boundaries.js";
import { labelValidationErrors } from "../../label/validation-errors.js";
import { isIngredientHeading, type LabelTextCandidateSchema } from "@crawl-automation/v3-contracts";
import type { z } from "zod";

type Candidate = z.infer<typeof LabelTextCandidateSchema>;
type Ingredients = NonNullable<Candidate["otherIngredients"]>;

// Text before the heading on the same line is tolerated when the heading starts a new clause: after the tail of a
// facts row (amount, %DV, footnote) or after sentence punctuation, as Amazon's one-line ingredient paragraphs read
// ("Vitamin D. Other Ingredients: Sugar, ..."). Never inside running prose ("We discuss Other Ingredients ...").
const clauseEnd = /(?:\d|%|\)|†|\*|\b(?:mg|mcg|iu|g)|[.;:!?])\s*$/i;
const warning =
  /\b(?:contains\s*:|may\s+contain|manufactured\s+(?:in|on)|processed\s+(?:in|on)|shared\s+equipment)/i;

/** Label codes for formula rows out of printed order within their column. */
export function rowOrderCodes(candidate: Candidate): string[] {
  const outOfOrder = (candidate.formula?.columns ?? []).some((column) =>
    column.rows.some((row, index) => {
      const previous = column.rows[index - 1];
      return previous !== undefined && row.name.start <= previous.name.end;
    }),
  );
  return outOfOrder ? [labelValidationErrors.code("LABEL.ROW_ORDER_INVALID")] : [];
}

/** Label codes for the ingredient section: a real heading, items inside it, one item per list entry. */
export function ingredientCodes(candidate: Candidate, text: string): string[] {
  const other = candidate.otherIngredients;
  if (!other) {
    return [];
  }
  const codes = new Set<string>();
  const lineStart = text.lastIndexOf("\n", other.heading.start - 1) + 1;
  const before = text.slice(lineStart, other.heading.start).trim();
  if (!isIngredientHeading(other.heading.text) || (before && !clauseEnd.test(before))) {
    codes.add(labelValidationErrors.code("LABEL.INGREDIENT_HEADING_INVALID"));
  }
  other.items.forEach((item, index) => {
    if (outsideSection(other, item, text)) {
      codes.add(labelValidationErrors.code("LABEL.INGREDIENT_ROLE_INVALID"));
    }
    if (crossesBoundary(other, index, text)) {
      codes.add(labelValidationErrors.code("LABEL.INGREDIENT_BOUNDARY"));
    }
  });
  return [...codes];
}

function outsideSection(other: Ingredients, item: Ingredients["items"][number], text: string) {
  const sinceHeading = text.slice(other.heading.end, item.start);
  return (
    item.start < other.heading.end ||
    warning.test(sinceHeading) ||
    warning.test(item.text) ||
    /(?:supplement|nutrition|drug)\s+facts|(?:other|inactive)?\s*ingredients\s*:/i.test(
      sinceHeading,
    )
  );
}

function crossesBoundary(other: Ingredients, index: number, text: string) {
  const item = other.items[index];
  const previous = other.items[index - 1];
  if (!item) {
    return false;
  }
  if (!completeIngredientItem(item.text)) {
    return true;
  }
  if (!previous) {
    return !/^\s*:?\s*$/.test(text.slice(other.heading.end, item.start));
  }
  return ingredientGap(text, previous, item) === null;
}
