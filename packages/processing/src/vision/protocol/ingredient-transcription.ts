import { recordRecovery } from "@crawl-automation/platform";
import { splitLabelIngredients, type LabelImageCandidate } from "@crawl-automation/v3-contracts";
import { labelValidationErrors } from "../../label/validation-errors.js";
import { splitIngredientTail } from "../../label/ingredient-tail.js";

type Candidate = LabelImageCandidate;

/** Repair only the decoded ingredient list; keep each image citation exactly as supplied. */
export function separateIngredientDeclarations(candidate: Candidate): Candidate {
  const other = candidate.otherIngredients;
  if (!other) {
    return candidate;
  }
  const items: typeof other.items = [];
  const exclusions: typeof candidate.exclusions = [];
  for (const item of other.items) {
    const split = splitIngredientTail(item.text);
    if (split.ingredient) {
      items.push({ ...item, text: split.ingredient.text });
    }
    if (split.allergen) {
      exclusions.push({ reason: "allergen", quote: { ...item, text: split.allergen.text } });
    }
    if (split.noise) {
      exclusions.push({ reason: "noise", quote: { ...item, text: split.noise.text } });
    }
  }
  if (candidate.exclusions.length + exclusions.length > 500) {
    return candidate;
  }
  candidate.otherIngredients = items.length ? { ...other, items } : null;
  candidate.exclusions.push(...exclusions);
  return candidate;
}

/** Other Ingredients items come from the transcribed body, split at top-level separators. */
export function splitOtherIngredients(
  candidate: Candidate,
  block: { text: string; evidence: string } | null,
  codes: Set<string>,
) {
  if (!!candidate.otherIngredients !== !!block) {
    codes.add(labelValidationErrors.code("LABEL.INGREDIENT_BOUNDARY"));
  }
  if (!candidate.otherIngredients || !block) {
    return;
  }
  if (block.text !== block.evidence) {
    codes.add(labelValidationErrors.code("LABEL.INGREDIENT_BOUNDARY"));
    return;
  }
  try {
    if (!transcribeBlock(candidate, candidate.otherIngredients, block)) {
      codes.add(labelValidationErrors.code("LABEL.INGREDIENT_BOUNDARY"));
    }
  } catch (error) {
    recordRecovery(error, { operation: "vision/protocol/label-vision-v2" });
    codes.add(labelValidationErrors.code("LABEL.INGREDIENT_BOUNDARY"));
  }
}

function transcribeBlock(
  candidate: Candidate,
  other: NonNullable<Candidate["otherIngredients"]>,
  block: { text: string; evidence: string },
): boolean {
  const tail = splitIngredientTail(block.text);
  if (candidate.exclusions.length + Number(!!tail.allergen) + Number(!!tail.noise) > 500) {
    return false;
  }
  const ingredientText =
    tail.allergen || tail.noise
      ? (tail.ingredient?.text.replace(/[,;]\s*$/u, "") ?? "")
      : block.text;
  const items = ingredientText
    ? splitLabelIngredients(ingredientText).map((text) => ({ text, evidence: text }))
    : [];
  candidate.otherIngredients = items.length ? { ...other, items } : null;
  if (tail.allergen) {
    candidate.exclusions.push({
      reason: "allergen",
      quote: { text: tail.allergen.text, evidence: block.evidence },
    });
  }
  if (tail.noise) {
    candidate.exclusions.push({
      reason: "noise",
      quote: { text: tail.noise.text, evidence: block.evidence },
    });
  }
  separateIngredientDeclarations(candidate);
  return true;
}
