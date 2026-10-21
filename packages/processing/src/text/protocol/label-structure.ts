import { completeIngredientItem, ingredientGap } from "./ingredient-boundaries.js";
import { labelValidationErrors } from "../../label/validation-errors.js";
import { isIngredientHeading, type LabelTextCandidateSchema } from "@crawl-automation/v3-contracts";
import {
  pseudoDrugFactsContext,
  pseudoInactiveListStartAllowed,
  pseudoInactivePositionAllowed,
} from "./pseudo-drug-facts.js";
import type { z } from "zod";

type Candidate = z.infer<typeof LabelTextCandidateSchema>;
type Ingredients = NonNullable<Candidate["otherIngredients"]>;

// Text before the heading on the same line is tolerated when the heading starts a new clause: after the tail of a
// facts row (amount, %DV, footnote) or after sentence punctuation, as Amazon's one-line ingredient paragraphs read
// ("Vitamin D. Other Ingredients: Sugar, ..."). Never inside running prose ("We discuss Other Ingredients ...").
const clauseEnd = /(?:\d|%|\)|†|\*|\d\s*(?:mg|mcg|iu|g)|[.,;:!?|]|<p>|-\s*-)\s*$/i;
const warning =
  /\b(?:contains\s*:|may\s+contain|manufactured\s+(?:in|on)|processed\s+(?:in|on)|shared\s+equipment)/i;
const INACTIVE_HEADING = /^inactive(?:\s+ingredients?(?:\(s\))?)?\s*:?$/i;

/** Label codes for formula rows out of printed order within their column. */
export function rowOrderCodes(candidate: Candidate): string[] {
  const outOfOrder = (candidate.formula?.columns ?? []).some((column) =>
    column.rows.some((row, index) => {
      const previous = column.rows[index - 1];
      if (!previous || row.name.start > previous.name.end) {
        return false;
      }
      // A blend total may print its component names on the same line. The first child is inside the parent's
      // cited name, then later children continue in printed order (Natrol Sleep+ Calm, 2026-10-21).
      const printedChild =
        row.kind === "blend_component" &&
        row.parentRowIndex === index - 1 &&
        previous.kind === "blend_total" &&
        row.name.start >= previous.name.start &&
        row.name.end <= previous.name.end &&
        row.amount === null &&
        row.dailyValue === null;
      return !printedChild;
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
  if (
    !ingredientHeadingAllowed(other) ||
    (/^inactive$/i.test(other.heading.text.trim()) &&
      !candidate.formula?.drugFacts &&
      !pseudoDrugFactsContext(candidate, text)) ||
    !ingredientHeadingPositionAllowed(candidate, text)
  ) {
    codes.add(labelValidationErrors.code("LABEL.INGREDIENT_HEADING_INVALID"));
  }
  if (ingredientItemsAreRows(other)) {
    codes.add(labelValidationErrors.code("LABEL.INGREDIENT_ITEMS_ARE_ROWS"));
  }
  other.items.forEach((item, index) => {
    if (outsideSection(other, item, text)) {
      codes.add(labelValidationErrors.code("LABEL.INGREDIENT_ROLE_INVALID"));
    }
    if (crossesBoundary(candidate, index, text)) {
      codes.add(labelValidationErrors.code("LABEL.INGREDIENT_BOUNDARY"));
    }
  });
  return [...codes];
}

function ingredientHeadingPositionAllowed(candidate: Candidate, text: string): boolean {
  const heading = candidate.otherIngredients?.heading;
  if (!heading) {
    return true;
  }
  const lineStart = text.lastIndexOf("\n", heading.start - 1) + 1;
  const before = text.slice(lineStart, heading.start).trim();
  if (simpleClausePrefix(before)) {
    return true;
  }
  if (doseClausePrefix(before)) {
    return true;
  }
  return inactiveClausePositionAllowed(candidate, text, {
    headingStart: heading.start,
    headingText: heading.text,
    before,
  });
}

function simpleClausePrefix(before: string): boolean {
  return !before || clauseEnd.test(before) || /\band\s+the$/i.test(before);
}

function doseClausePrefix(before: string): boolean {
  return /(?:daily\s+value(?:\s*\(dv\))?\s+not\s+established|\d+(?:\.\d+)?\s*mg\s+per\s+tablet)$/i.test(
    before,
  );
}

function inactiveClausePositionAllowed(
  candidate: Candidate,
  text: string,
  source: { headingStart: number; headingText: string; before: string },
): boolean {
  return (
    INACTIVE_HEADING.test(source.headingText.trim()) &&
    (!!candidate.formula?.drugFacts ||
      (pseudoDrugFactsContext(candidate, text) &&
        pseudoInactivePositionAllowed(candidate, text, source.headingStart)) ||
      adjacentIngredientsPrefix(candidate, text, source))
  );
}

function adjacentIngredientsPrefix(
  candidate: Candidate,
  text: string,
  source: { headingStart: number; before: string },
): boolean {
  return (
    /^Ingredients$/i.test(source.before) &&
    candidate.exclusions.some(
      (exclusion) =>
        exclusion.reason === "heading" &&
        /^Ingredients$/i.test(exclusion.quote.text.trim()) &&
        exclusion.quote.end <= source.headingStart &&
        /^\s*$/.test(text.slice(exclusion.quote.end, source.headingStart)),
    )
  );
}

/** Local aliases are limited to headings whose following citations form an ingredient list. */
export function ingredientHeadingAllowed(other: Ingredients): boolean {
  const heading = other.heading.text.trim();
  return (
    isIngredientHeading(heading) ||
    /^inactive(?:\s+ingredients?(?:\(s\))?)?\s*:?$/i.test(heading) ||
    (/^contains:?$/i.test(heading) && other.items.length > 1) ||
    /^other\s+ingredients\s*:\s*may\s+contain\s+any\s+or\s+all\s+of\s+the\s+following\s*:?$/i.test(
      heading,
    )
  );
}

/** Multiple cited dose-bearing entries are formula rows, not an ingredient declaration. */
export function ingredientItemsAreRows(other: Ingredients): boolean {
  return (
    other.items.filter((item) => /\b\d+(?:[.,]\d+)?\s*(?:mcg|mg|g|iu)\b/i.test(item.text)).length >=
    2
  );
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

function crossesBoundary(candidate: Candidate, index: number, text: string) {
  const other = candidate.otherIngredients;
  if (!other) {
    return false;
  }
  const item = other.items[index];
  const previous = other.items[index - 1];
  if (!item) {
    return false;
  }
  if (!completeIngredientItem(item.text, other.items.length > 1)) {
    return true;
  }
  if (!previous) {
    return (
      !/^\s*[:,]?\s*(?:<p>\s*)*$/i.test(text.slice(other.heading.end, item.start)) &&
      !pseudoInactiveListStartAllowed(candidate, text)
    );
  }
  const headings = candidate.exclusions
    .filter((exclusion) => exclusion.reason === "heading")
    .map((exclusion) => exclusion.quote);
  return ingredientGap(text, previous, { next: item, headings }) === null;
}
