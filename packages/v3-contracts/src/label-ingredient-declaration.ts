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
  if (declaration.state === "present") {
    return !candidate.otherIngredients || !candidate.ingredientsComplete;
  }
  if (declaration.state === "not_fully_visible") {
    return !candidate.ingredientsComplete || !hasClosedPrintedIngredients(candidate);
  }
  return !hasConfirmedNoOtherIngredients(candidate);
}

/** A printed list can end before the rest of the physical package comes into view. */
export function hasClosedPrintedIngredients(candidate: LabelCandidate): boolean {
  const other = candidate.otherIngredients;
  return (
    !!other &&
    other.items.length > 0 &&
    !candidate.issues.some((issue) => issue.code === "UNREADABLE") &&
    !unreadableMarker.test(other.heading.text) &&
    !("evidence" in other.heading && unreadableMarker.test(other.heading.evidence)) &&
    other.items.every(
      (item) =>
        isClosedIngredientItem(item.text) &&
        !("evidence" in item && unreadableMarker.test(item.evidence)),
    )
  );
}

const unreadableMarker = /\[?unreadable\]?|\u2026|\.\.\./iu;

function isClosedIngredientItem(text: string): boolean {
  const item = text.trim();
  if (
    unreadableMarker.test(item) ||
    /^(?:none|n\/?a)$/iu.test(item) ||
    /[,;:(\[]\s*$/u.test(item) ||
    /\b(?:and|or|per)\s*$/iu.test(item)
  ) {
    return false;
  }
  let depth = 0;
  for (const char of item) {
    if (char === "(") depth++;
    if (char === ")" && --depth < 0) return false;
  }
  return depth === 0;
}
