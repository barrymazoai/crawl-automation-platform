import { drugActiveHeading, factsHeadingLines } from "@crawl-automation/v3-contracts";
import { labelCoreFailure } from "../label-core-errors.js";

/** Prefer the specific heading. Only the selected spelling contributes to the ambiguity count. */
export function ingredientHeadingIndexes(headings: string[], drug = false): number[] {
  const preferred = drug ? /^Inactive Ingredients\s*:?$/i : /^Other\s+Ingredients\s*:?$/i;
  const indexes = (pattern: RegExp) =>
    headings.flatMap((heading, index) => (pattern.test(heading.trim()) ? [index] : []));
  const selected = indexes(preferred);
  return selected.length || drug ? selected : indexes(/^Ingredients\s*:?$/i);
}

/** Every complete facts heading in a scoped source; a second panel is never silently truncated. */
export const labelFactsHeadings = (text: string) => [...text.matchAll(factsHeadingLines)];

const AFTER_INACTIVE =
  /^[ \t]*(?:Questions\??|Country of Origin|Additional Product Information|Uses|Warnings?|Directions|Other Information)[ \t]*(?::|$)/im;

/** One Drug Facts panel, retaining all printed text through its inactive ingredient body. */
export function extractDrugFactsCore(text: string): string {
  const headings = labelFactsHeadings(text);
  const [heading] = headings;
  if (headings.length !== 1 || !heading || !/^Drug Facts/i.test(heading[0].trim())) {
    throw labelCoreFailure("LABEL_CORE.LABEL_SCOPE_AMBIGUOUS");
  }
  const facts = text.slice(heading.index);
  const ingredients = [...facts.matchAll(/^Inactive Ingredients[ \t]*(?::|$)/gim)];
  const [inactive] = ingredients;
  const active = facts
    .slice(0, inactive?.index)
    .split("\n")
    .some((line) => drugActiveHeading.test(line.trim()));
  if (!inactive || ingredients.length !== 1 || !active || !/\bPurpose\b/i.test(facts)) {
    throw labelCoreFailure("LABEL_CORE.TABLE_UNVERIFIED");
  }
  return throughInactive(facts, inactive.index + inactive[0].length);
}

function throughInactive(facts: string, after: number): string {
  const tail = facts.slice(after);
  const end = AFTER_INACTIVE.exec(tail)?.index ?? tail.length;
  const body = tail.slice(0, end).trim();
  if (!body || body.includes("\n\n")) {
    throw labelCoreFailure("LABEL_CORE.INGREDIENT_SCOPE_AMBIGUOUS");
  }
  return facts.slice(0, after + end).trim();
}
