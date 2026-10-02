import { recordRecovery } from "@crawl-automation/platform";
import { splitLabelIngredients, type LabelImageCandidate } from "@crawl-automation/v3-contracts";
import { labelValidationErrors } from "../../label/validation-errors.js";

type Candidate = LabelImageCandidate;

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
    const items = splitLabelIngredients(block.text).map((text) => ({ text, evidence: text }));
    candidate.otherIngredients.items = items;
  } catch (error) {
    recordRecovery(error, { operation: "vision/protocol/label-vision-v2" });
    codes.add(labelValidationErrors.code("LABEL.INGREDIENT_BOUNDARY"));
  }
}
