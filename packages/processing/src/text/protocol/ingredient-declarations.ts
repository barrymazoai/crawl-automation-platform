import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { splitIngredientTail, type IngredientPart } from "../../label/ingredient-tail.js";
import type { Quote } from "./evidence-lines.js";

function quote(original: Quote, part: IngredientPart): Quote {
  return {
    text: part.text,
    start: original.start + part.start,
    end: original.start + part.end,
  };
}

/** All derived citations are slices of an already placed, exact source quote. */
export function separateTextIngredientDeclarations(candidate: LabelTextCandidate): void {
  const other = candidate.otherIngredients;
  if (!other) {
    return;
  }
  const items: Quote[] = [];
  const exclusions: LabelTextCandidate["exclusions"] = [];
  for (const item of other.items) {
    const split = splitIngredientTail(item.text);
    if (split.ingredient) {
      items.push(quote(item, split.ingredient));
    }
    if (split.allergen) {
      exclusions.push({ reason: "allergen", quote: quote(item, split.allergen) });
    }
    if (split.noise) {
      exclusions.push({ reason: "noise", quote: quote(item, split.noise) });
    }
  }
  if (candidate.exclusions.length + exclusions.length > 500) {
    return;
  }
  candidate.otherIngredients = items.length ? { ...other, items } : null;
  candidate.exclusions.push(...exclusions);
}
