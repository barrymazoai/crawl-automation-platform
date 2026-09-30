import type { TextInput } from "@crawl-automation/v3-contracts";
import { textFailure } from "../errors.js";
import type { Quote } from "./evidence-lines.js";

export const otherIngredientsHeading = /\b(?:other|oher)\s+ingredients\s*:/i;
export const allergenWarning =
  /\b(?:contains\s*:|manufactured\s+(?:in|on)|processed\s+(?:in|on)|shared\s+equipment|may\s+contain)/i;

export interface AnchoredItem extends Quote {
  role: "blend_component" | "other";
  parentNutrientIndex: number | null;
}
interface Nutrient {
  name: Quote;
}
interface Checked {
  input: TextInput;
  text: string;
  nutrients: readonly Nutrient[];
}

const lastMatch = (text: string, pattern: RegExp) =>
  [...text.matchAll(new RegExp(pattern.source, "ig"))].at(-1);
const roleInvalid = () => textFailure("TEXT.ROLE_INVALID", "executed");

/** Each ingredient sits in its section: an "other" item after the heading, a component after its blend. */
export function assertIngredientRoles(items: readonly AnchoredItem[], checked: Checked): void {
  for (const item of items) {
    // Never promote warnings to ingredients, even when their text is a valid citation.
    const prefix = checked.text.slice(checked.input.range.start, item.start);
    const warningStart = lastMatch(prefix, allergenWarning)?.index;
    const headingStart = lastMatch(prefix, otherIngredientsHeading)?.index;
    if (warningStart !== undefined && (headingStart === undefined || warningStart > headingStart)) {
      throw roleInvalid();
    }
    if (allergenWarning.test(item.text)) {
      throw roleInvalid();
    }
    if (item.role === "other" ? !inIngredientSection(prefix) : !underItsBlend(item, checked)) {
      throw roleInvalid();
    }
  }
}

function inIngredientSection(before: string): boolean {
  const heading = lastMatch(before, otherIngredientsHeading);
  if (!heading) {
    return false;
  }
  const since = before.slice((heading.index ?? 0) + heading[0].length);
  return !allergenWarning.test(since) && !/\bsupplement\s+facts\b/i.test(since);
}

function underItsBlend(item: AnchoredItem, checked: Checked): boolean {
  const parent = checked.nutrients[item.parentNutrientIndex ?? -1];
  if (!parent || !/\b(?:blend|complex|matrix)\b/i.test(parent.name.text)) {
    return false;
  }
  if (item.start <= parent.name.end) {
    return false;
  }
  if (otherIngredientsHeading.test(checked.text.slice(parent.name.end, item.start))) {
    return false;
  }
  return !checked.nutrients.some(
    (nutrient) => nutrient.name.start > parent.name.start && nutrient.name.start < item.start,
  );
}

/** One item per ingredient: no top-level separator inside an item, no line wrap between siblings. */
export function assertIngredientBoundaries(items: readonly AnchoredItem[], text: string): void {
  const ordered = [...items].sort((first, second) => first.start - second.start);
  ordered.forEach((item, index) => {
    const previous = ordered[index - 1];
    // A line wrap is not an ingredient delimiter; a top-level comma is.
    if (invalidIngredientBoundary(item.text)) {
      throw textFailure("TEXT.INGREDIENT_BOUNDARY", "executed");
    }
    const sameList =
      previous?.role === item.role && previous.parentNutrientIndex === item.parentNutrientIndex;
    const onlySpace = previous && /^\s*$/.test(text.slice(previous.end, item.start));
    if (previous && (previous.end > item.start || (sameList && onlySpace))) {
      throw textFailure("TEXT.INGREDIENT_BOUNDARY", "executed");
    }
  });
}

/** Separators count only at depth zero; unmatched or mismatched brackets leave the boundary unverified. */
function invalidIngredientBoundary(text: string): boolean {
  const closingBrackets: string[] = [];
  for (const character of text) {
    if (character === "(" || character === "[") {
      closingBrackets.push(character === "(" ? ")" : "]");
    } else if (character === ")" || character === "]") {
      if (closingBrackets.pop() !== character) {
        return true;
      }
    } else if (/[,;]/.test(character) && closingBrackets.length === 0) {
      return true;
    }
  }
  return closingBrackets.length !== 0;
}
