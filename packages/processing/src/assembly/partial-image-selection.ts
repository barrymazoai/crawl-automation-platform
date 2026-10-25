import {
  formulaAgreement,
  isCompleteLabelImage,
  labelAgreementFormula,
  projectLabelProductCandidate,
} from "@crawl-automation/v3-contracts";
import { assemblyErrors } from "./assembly-errors.js";
import type { MergePolicy } from "./merge-policy.js";
import { isPartialLabel, partialLabelConflicts, splitConflictsFor } from "./partial-label.js";
import {
  fail,
  joinVerifiedFormulaSections,
  type MergeState,
  type LabelEvidence,
} from "./merge-state.js";

/** /6 applies the same readable-conflict guard to registered and reviewed incomplete images. */
export function selectPartialImage(
  state: MergeState,
  entry: LabelEvidence,
  policy: MergePolicy,
): boolean {
  if (
    !policy.sufficient ||
    !policy.completeLabel ||
    entry.kind !== "image" ||
    isCompleteLabelImage(entry)
  ) {
    return false;
  }
  if (!isPartialLabel(entry.candidate)) {
    return false;
  }
  const complete = policy.split ? [policy.split.complete] : policy.complete;
  const conflicts = policy.split
    ? splitConflictsFor(entry, policy.split)
    : complete.flatMap((full) => partialLabelConflicts(entry.candidate, full.candidate));
  conflicts.forEach((code) => fail(state, entry.id, code));
  if (conflicts.length) {
    return true;
  }
  if (deferSeparateSection(state, entry, complete)) {
    return true;
  }
  state.warnings.push({
    id: entry.id,
    code: assemblyErrors.code("LABEL_PRODUCT.INCOMPLETE_IMAGE_NOT_SELECTED"),
  });
  return true;
}

/**
 * The lower half of a panel photographed apart from its Facts header (B001E11AP8, 2026-10-21) is kept aside and
 * joined to the selected formula once every source has been seen, so the order of image IDs does not decide it.
 */
export function deferSeparateSection(
  state: MergeState,
  entry: LabelEvidence,
  complete: LabelEvidence[],
): boolean {
  const formula = entry.candidate.formula;
  const separate =
    entry.kind === "image" &&
    !!formula &&
    complete.some(
      (full) =>
        !!full.candidate.formula &&
        formulaAgreement(formula, full.candidate.formula) === "sections",
    );
  if (separate) {
    state.pendingSections.push(entry);
  }
  return separate;
}

/** Separate sections of the selected panel are joined after the selection; anything else only warns. */
export function joinPendingSections(state: MergeState): void {
  const comparison = state.manifest.admission?.comparison;
  for (const entry of state.pendingSections) {
    const projected = projectLabelProductCandidate(entry.id, entry.candidate);
    const shape = labelAgreementFormula(entry.candidate, comparison);
    const joined =
      !!shape &&
      !!state.formulaShape &&
      formulaAgreement(state.formulaShape, shape) === "sections" &&
      joinVerifiedFormulaSections(state, { entry, projected, shape });
    if (!joined) {
      state.warnings.push({
        id: entry.id,
        code: assemblyErrors.code("LABEL_PRODUCT.INCOMPLETE_IMAGE_NOT_SELECTED"),
      });
    }
  }
  state.pendingSections = [];
}
