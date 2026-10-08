import { assemblyErrors, type AssemblyErrorCode } from "./assembly-errors.js";
import {
  isCompleteLabelImage,
  isOrderedEvidencePolicy,
  formulaAgreement,
  ingredientsAgreement,
  labelAgreementFormula,
  labelAgreementIngredients,
  projectLabelProductCandidate,
  type LabelAgreement,
} from "@crawl-automation/v3-contracts";
import type { MergePolicy } from "./merge-policy.js";
import { byText, type MergeState, type LabelEvidence } from "./merge-state.js";
import { reviewEntry } from "./merge-entry-review.js";
import { sameServingSize } from "./serving-size.js";
import { partialLabelConflicts } from "./partial-label.js";
type Candidate = LabelEvidence["candidate"];
type Projected = ReturnType<typeof projectLabelProductCandidate>;

/**
 * Picks the formula and the other ingredients: a complete image first, then images, then text when an image leads;
 * otherwise by source ID. Every later source must agree with what was picked, or the conflict is recorded.
 */
export function selectLabel(
  state: MergeState,
  provenance: LabelEvidence[],
  policy: MergePolicy,
): void {
  const priority = (entry: LabelEvidence) => {
    if (!policy.imageFirst || isCompleteLabelImage(entry)) {
      return 0;
    }
    return entry.kind === "image" ? 1 : 2;
  };
  const ordered = [...provenance].sort(
    (left, right) => priority(left) - priority(right) || byText(left.id, right.id),
  );
  for (const entry of ordered) {
    selectEntry(state, entry, policy);
  }
}

function selectEntry(state: MergeState, entry: LabelEvidence, policy: MergePolicy): void {
  if (policy.split) {
    const conflicts = partialLabelConflicts(
      entry.candidate,
      policy.split.complete.candidate,
      policy.split.parts,
    );
    conflicts.forEach((code) => state.codes.add(code));
    const section = policy.split.sections.get(entry.id);
    if (section) {
      selectSections(state, section, policy);
      return;
    }
  }
  if (reviewEntry(state, entry, policy)) {
    return;
  }
  selectSections(state, entry, policy);
}

function selectSections(state: MergeState, entry: LabelEvidence, policy: MergePolicy): void {
  const candidate = entry.candidate;
  const projected = projectLabelProductCandidate(entry.id, candidate);
  const secondaryText = policy.imageFirst && entry.kind === "text";
  const pick = { entry, candidate, projected, secondaryText, imageFirst: policy.imageFirst };
  selectFormula(state, pick);
  selectOtherIngredients(state, pick);
}

interface Pick {
  entry: LabelEvidence;
  candidate: Candidate;
  projected: Projected;
  secondaryText: boolean;
  /** A complete image leads this product: packaging serving-size conflicts only warn. */
  imageFirst: boolean;
}

function selectFormula(state: MergeState, pick: Pick): void {
  const { candidate, projected, secondaryText } = pick;
  if (!candidate.formula) {
    return;
  }
  const comparison = state.manifest.admission?.comparison;
  const shape = labelAgreementFormula(candidate, comparison);
  if (!shape) {
    return;
  }
  checkAgainstPackaging(state, shape, pick);
  if (state.formulaShape) {
    recordAgreement(state, pick, {
      agreement: formulaAgreement(state.formulaShape, shape),
      conflict: "LABEL_PRODUCT.FORMULA_CONFLICT",
      secondary: "LABEL_PRODUCT.SECONDARY_TEXT_FORMULA_CONFLICT",
    });
  }
  if (!state.formula && !secondaryText) {
    state.formulaShape = shape;
    state.formula = projected.formula;
  }
}

type Shape = NonNullable<ReturnType<typeof labelAgreementFormula>>;

/**
 * With packaging evidence, the container count is compared across sources but never kept as a per-serving value (the
 * original stays in the provenance), and the serving size must match the page's.
 */
function checkAgainstPackaging(state: MergeState, shape: Shape, pick: Pick): void {
  const { packaging } = state;
  if (!packaging) {
    return;
  }
  if (shape.servingsPerContainer) {
    state.counts.add(shape.servingsPerContainer);
  }
  shape.servingsPerContainer = null;
  const servingSize = packaging.servingSize.value;
  if (
    !servingSize ||
    (shape.drugFacts && !shape.servingSize) ||
    (shape.servingSize && sameServingSize(shape.servingSize, servingSize))
  ) {
    return;
  }
  if (pick.imageFirst) {
    state.warnings.push({
      id: pick.entry.id,
      code: assemblyErrors.code("PACKAGING.SERVING_SIZE_CONFLICT"),
    });
  } else {
    state.codes.add(assemblyErrors.code("PACKAGING.SERVING_SIZE_CONFLICT"));
  }
}

function selectOtherIngredients(state: MergeState, pick: Pick): void {
  const { candidate, projected, secondaryText } = pick;
  if (!candidate.otherIngredients && !labelAgreementIngredients(candidate)) {
    return;
  }
  const comparison = state.manifest.admission?.comparison;
  const shape = labelAgreementIngredients(candidate);
  if (state.otherShape || secondaryText) {
    recordAgreement(state, pick, {
      agreement: ingredientsAgreement(state.otherShape, shape, comparison),
      conflict: "LABEL_PRODUCT.INGREDIENTS_CONFLICT",
      secondary: "LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT",
    });
  }
  if (state.otherShape === null && !secondaryText) {
    state.otherShape = shape;
    state.otherIngredients = projected.otherIngredients;
  }
}

function recordAgreement(
  state: MergeState,
  pick: Pick,
  comparison: {
    agreement: LabelAgreement;
    conflict: AssemblyErrorCode;
    secondary: AssemblyErrorCode;
  },
): void {
  const { agreement, conflict, secondary } = comparison;
  const secondaryText =
    pick.secondaryText && !isOrderedEvidencePolicy(state.manifest.evidencePolicy);
  if (agreement === "exact") {
    return;
  }
  const wording = agreement === "wording";
  const code = assemblyErrors.code(
    wording ? "LABEL_PRODUCT.SOURCE_WORDING_DIFFERS" : secondaryText ? secondary : conflict,
  );
  const id = pick.entry.id;
  if (wording || secondaryText) {
    if (!state.warnings.some((warning) => warning.id === id && warning.code === code)) {
      state.warnings.push({ id, code });
    }
  } else {
    state.codes.add(code);
  }
}
