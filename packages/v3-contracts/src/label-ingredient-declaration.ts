import { z } from "zod";
import type { LabelCandidate } from "./label-extraction.js";

/** A visual observation, not invented printed text or a substitute for an unseen panel. */
export const LabelIngredientDeclarationSchema = z.strictObject({
  protocol: z.literal("label-visual-wire/3"),
  state: z.enum(["present", "none_printed", "not_fully_visible", "unreadable"]),
  wholeLabelVisible: z.boolean(),
  /** Recorded by the caller, never chosen by the model. */
  allowNoOtherIngredientsSection: z.boolean(),
});

export function hasConfirmedNoOtherIngredients(candidate: LabelCandidate): boolean {
  if (!candidate.formula || !enabledAbsence(candidate)) {
    return false;
  }
  return (
    !candidate.formula.drugFacts &&
    candidate.formulaComplete &&
    candidate.ingredientsComplete &&
    candidate.otherIngredients === null &&
    candidate.issues.length === 0
  );
}

function enabledAbsence(candidate: LabelCandidate): boolean {
  const declaration = "ingredientDeclaration" in candidate && candidate.ingredientDeclaration;
  return (
    !!declaration &&
    declaration.state === "none_printed" &&
    declaration.wholeLabelVisible &&
    declaration.allowNoOtherIngredientsSection
  );
}

/** Invalid or disabled absence claims must never become partial successes eligible for assembly. */
export function ingredientDeclarationIncomplete(candidate: LabelCandidate): boolean {
  const declaration = "ingredientDeclaration" in candidate && candidate.ingredientDeclaration;
  if (!declaration) {
    return false;
  }
  return declaration.state === "present"
    ? !candidate.otherIngredients || !candidate.ingredientsComplete
    : !hasConfirmedNoOtherIngredients(candidate);
}
