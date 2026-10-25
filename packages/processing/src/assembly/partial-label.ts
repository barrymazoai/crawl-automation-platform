import {
  assessLabelCandidate,
  completeLabelSections,
  labelAgreementIngredients,
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

type Split = NonNullable<ReturnType<typeof splitLabel>>;

/** The kind of source whose printed list the split selected (the formula's owner may be another source). */
function ingredientOwnerKind(split: Split): LabelEvidence["kind"] | null {
  const list = split.complete.candidate.otherIngredients;
  if (!list) {
    return null;
  }
  return (
    [...split.sections.values()].find((entry) => entry.candidate.otherIngredients === list)?.kind ??
    null
  );
}

/** The warning a page carries when its list yields to the image's printed list; recorded once. */
export function warnPageYields(warnings: { id: string; code: string }[], pageId: string): void {
  const code = assemblyErrors.code("LABEL_PRODUCT.INGREDIENTS_PAGE_DIFFERS");
  if (!warnings.some((warning) => warning.id === pageId && warning.code === code)) {
    warnings.push({ id: pageId, code });
  }
}

/**
 * The split's conflicts for one source. A page whose list differs from the image's printed list is not one (owner
 * 2026-10-25: the image wins) and carries the yield warning. An image against the page's list is left to ingredient
 * selection only when the image's own whole section is selected there; otherwise it stays a conflict, so the page
 * never wins silently. Two images, or an image with no printed list, stay conflicts too.
 */
export function splitConflictsFor(
  entry: Pick<LabelEvidence, "id" | "kind" | "candidate">,
  split: Split,
  warnings?: { id: string; code: string }[],
): string[] {
  const conflict = assemblyErrors.code("LABEL_PRODUCT.INGREDIENTS_CONFLICT");
  const all = partialLabelConflicts(entry.candidate, split.complete.candidate, split.parts);
  if (!all.includes(conflict) || !pageAgainstImage(entry, split)) {
    return all;
  }
  if (warnings && entry.kind === "text") {
    warnPageYields(warnings, entry.id);
  }
  return all.filter((code) => code !== conflict);
}

/** A page against the image's list, or an image whose whole section ingredient selection compares with the page. */
function pageAgainstImage(entry: Pick<LabelEvidence, "id" | "kind" | "candidate">, split: Split) {
  const owner = ingredientOwnerKind(split);
  if (entry.kind === "text") {
    return (
      owner === "image" && (labelAgreementIngredients(split.complete.candidate)?.length ?? 0) > 0
    );
  }
  const section = split.sections.get(entry.id);
  return (
    owner === "text" && !!section && (labelAgreementIngredients(section.candidate)?.length ?? 0) > 0
  );
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
