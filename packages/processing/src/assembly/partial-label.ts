import {
  assessLabelCandidate,
  completeLabelSections,
  partialLabelValidationCodes,
  type LabelCandidate,
} from "@crawl-automation/v3-contracts";
import { labelValidationErrors } from "../label/validation-errors.js";
import { assemblyErrors } from "./assembly-errors.js";
import { splitLabel } from "./split-label.js";
import { formulaFits, ingredientsFit } from "./partial-label-fit.js";
import type { LabelEvidence } from "./merge-state.js";

export const partialLabelCodes: readonly string[] = partialLabelValidationCodes.map((code) =>
  labelValidationErrors.code(code),
);

/** A retained one-section image may contribute only its intact printed section. */
export function partialImageSection(
  candidate: LabelCandidate,
): "formula only" | "ingredients only" | null {
  const sections = completeLabelSections(candidate);
  if (!sections || uncertainSection(candidate)) {
    return null;
  }
  if (formulaOnlySection(candidate, sections)) {
    return "formula only";
  }
  if (ingredientsOnlySection(candidate, sections)) {
    return "ingredients only";
  }
  return null;
}

function uncertainSection(candidate: LabelCandidate) {
  return candidate.issues.some((issue) =>
    ["UNREADABLE", "AMBIGUOUS", "METADATA_CONFLICT"].includes(issue.code),
  );
}

function formulaOnlySection(candidate: LabelCandidate, sections: LabelCandidate) {
  return (
    !!sections.formula &&
    sections.formulaComplete &&
    !candidate.otherIngredients &&
    !candidate.ingredientsComplete &&
    candidate.issues.every((issue) => issue.code === "INGREDIENTS_MISSING")
  );
}

function ingredientsOnlySection(candidate: LabelCandidate, sections: LabelCandidate) {
  return (
    !candidate.formula &&
    !!sections.otherIngredients &&
    sections.ingredientsComplete &&
    candidate.issues.every((issue) => issue.code === "FORMULA_MISSING")
  );
}

/** Keep existing section conflict checks even when a proposed cross-image join is refused. */
export function resolveSplit(eligible: LabelEvidence[], onePart: boolean) {
  const proposed = splitLabel(eligible, onePart);
  if (!proposed) {
    return { split: null, conflicts: [] as string[], ingredientImageId: null as string | null };
  }
  const ingredientImage = eligible.find(
    (entry) => entry.candidate.otherIngredients === proposed.complete.candidate.otherIngredients,
  );
  if (!safeSplit(proposed, eligible, ingredientImage)) {
    return {
      split: null,
      conflicts: eligible.flatMap((entry) =>
        partialLabelConflicts(entry.candidate, proposed.complete.candidate, proposed.parts),
      ),
      ingredientImageId: null,
    };
  }
  return {
    split: proposed,
    conflicts: [] as string[],
    ingredientImageId:
      proposed.parts.formula &&
      proposed.parts.ingredients &&
      proposed.complete.kind === "image" &&
      ingredientImage?.kind === "image" &&
      ingredientImage.id !== proposed.complete.id
        ? ingredientImage.id
        : null,
  };
}

/** A second image cannot replace a list already visible with the Facts panel. */
function safeSplit(
  split: NonNullable<ReturnType<typeof splitLabel>>,
  eligible: LabelEvidence[],
  ingredientImage: LabelEvidence | undefined,
) {
  if (!split.parts.formula || !split.parts.ingredients) {
    return true;
  }
  const facts = eligible.find((entry) => entry.id === split.complete.id);
  if (!differentImagePair(facts, ingredientImage)) {
    return true;
  }
  if (
    facts?.candidate.issues.some((issue) => issue.code === "INGREDIENTS_MISSING") &&
    facts.candidate.issues.some((issue) => issue.code === "UNREADABLE")
  ) {
    return false;
  }
  return !facts.candidate.otherIngredients;
}

function differentImagePair(
  facts: LabelEvidence | undefined,
  ingredients: LabelEvidence | undefined,
): facts is LabelEvidence {
  return facts?.kind === "image" && ingredients?.kind === "image" && facts.id !== ingredients.id;
}

/**
 * A partial panel may omit unreadable content, but every readable field must agree with the full label. A part the
 * selected label does not carry (/7) is not compared: there is nothing to disagree with.
 */
export function partialLabelConflicts(
  partial: LabelCandidate,
  complete: LabelCandidate,
  parts: { formula: boolean; ingredients: boolean } = { formula: true, ingredients: true },
): string[] {
  const codes: string[] = [];
  const formula = parts.formula && partial.formula;
  if (formula && (!complete.formula || !formulaFits(formula, complete.formula))) {
    codes.push(assemblyErrors.code("LABEL_PRODUCT.FORMULA_CONFLICT"));
  }
  if (parts.ingredients && partial.otherIngredients && !ingredientsFit(partial, complete)) {
    codes.push(assemblyErrors.code("LABEL_PRODUCT.INGREDIENTS_CONFLICT"));
  }
  return codes;
}

/** Refuse ambiguous content and all errors beyond the explicitly allowed incomplete-panel codes. */
export function isPartialLabel(candidate: LabelCandidate): boolean {
  const assessed = assessLabelCandidate(candidate);
  const incomplete =
    !candidate.formulaComplete || !candidate.ingredientsComplete || assessed.status === "review";
  return (
    incomplete &&
    !candidate.issues.some((issue) => ["AMBIGUOUS", "METADATA_CONFLICT"].includes(issue.code)) &&
    assessed.codes.every((code) => partialLabelCodes.includes(code))
  );
}
