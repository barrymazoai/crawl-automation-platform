import {
  undosedIngredientParagraph,
  type LabelTextCandidate,
} from "@crawl-automation/v3-contracts";

/** Replace a fully cited Ingredients paragraph misread as undosed formula rows. */
export function normalizeUndosedIngredientParagraph(
  candidate: LabelTextCandidate,
  text: string,
  range: { start: number; end: number },
) {
  const paragraph = undosedIngredientParagraph({ candidate, text, range });
  if (paragraph) {
    candidate.formula = null;
    candidate.otherIngredients = paragraph;
    candidate.formulaComplete = false;
    candidate.ingredientsComplete = true;
    candidate.ingredientParagraphReclassified = true;
  }
  return paragraph?.heading ?? null;
}
