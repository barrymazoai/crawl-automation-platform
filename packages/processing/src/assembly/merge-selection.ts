import { assemblyErrors, type AssemblyErrorCode } from "./assembly-errors.js";
import type { Shape } from "./packaging-serving-check.js";
import {
  isCompleteLabelImage,
  isOrderedEvidencePolicy,
  formulaAgreement,
  labelAgreementFormula,
  preferFormulaSource,
  projectLabelProductCandidate,
  type LabelAgreement,
} from "@crawl-automation/v3-contracts";
import type { MergePolicy } from "./merge-policy.js";
import {
  byText,
  joinVerifiedFormulaSections,
  type MergeState,
  type LabelEvidence,
} from "./merge-state.js";
import { reviewEntry } from "./merge-entry-review.js";
import { checkAgainstPackaging } from "./packaging-serving-check.js";
import { splitConflictsFor } from "./partial-label.js";
import { selectOtherIngredients } from "./ingredient-selection.js";
import { deferSeparateSection, joinPendingSections } from "./partial-image-selection.js";
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
  state.anyFormula = provenance.some((entry) => entry.candidate.formula !== null);
  for (const entry of ordered) {
    selectEntry(state, entry, policy);
  }
  joinPendingSections(state);
}

function selectEntry(state: MergeState, entry: LabelEvidence, policy: MergePolicy): void {
  const split = policy.split;
  if (split) {
    const conflicts = splitConflictsFor(entry, split, state.warnings);
    conflicts.forEach((code) => state.codes.add(code));
    const section = split.sections.get(entry.id);
    if (section) {
      // The split path skips reviewEntry, so retain the decoder's ingredient-list correction warning.
      if (entry.kind === "text" && entry.candidate.ingredientParagraphReclassified) {
        state.warnings.push({ id: entry.id, code: "LABEL.FORMULA_IS_INGREDIENT_LIST" });
      }
      selectSections(state, section, policy);
      if (!section.candidate.formula && !conflicts.length) {
        // The section kept only its intact ingredients; its incomplete formula may still be the panel's other half.
        deferSeparateSection(state, entry, [split.complete]);
      }
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
    compareFormula(state, pick, shape);
  }
  if (!state.formula && !secondaryText) {
    state.formulaShape = shape;
    state.formulaSource = pick.entry;
    state.formulaSources = [pick.entry];
    state.formula = projected.formula;
  }
}

function compareFormula(state: MergeState, pick: Pick, shape: Shape): void {
  const agreement = formulaAgreement(state.formulaShape, shape);
  if (agreement === "subset") {
    acceptFormulaSubset(state, pick, shape);
  } else if (agreement === "sections") {
    if (
      !joinVerifiedFormulaSections(state, { entry: pick.entry, projected: pick.projected, shape })
    ) {
      state.codes.add(assemblyErrors.code("LABEL_PRODUCT.FORMULA_CONFLICT"));
    }
  } else {
    recordAgreement(state, pick, {
      agreement,
      conflict: "LABEL_PRODUCT.FORMULA_CONFLICT",
      secondary: "LABEL_PRODUCT.SECONDARY_TEXT_FORMULA_CONFLICT",
    });
  }
}

function acceptFormulaSubset(state: MergeState, pick: Pick, shape: Shape): void {
  const selected = state.formulaSource;
  if (!selected) {
    return;
  }
  const replace =
    state.formulaSources.length === 1 &&
    !pick.secondaryText &&
    preferFormulaSource(selected.candidate, pick.candidate);
  const shorter = replace ? selected.id : pick.entry.id;
  state.warnings.push({ id: shorter, code: assemblyErrors.code("LABEL_PRODUCT.FORMULA_SUBSET") });
  if (replace) {
    state.formulaShape = shape;
    state.formulaSource = pick.entry;
    state.formulaSources = [pick.entry];
    state.formula = pick.projected.formula;
  }
}

function recordAgreement(
  state: MergeState,
  pick: Pick,
  comparison: {
    agreement: LabelAgreement;
    conflict: AssemblyErrorCode;
    secondary: AssemblyErrorCode;
    imageWins?: boolean;
  },
): void {
  const { agreement, conflict, secondary, imageWins = false } = comparison;
  const secondaryText =
    pick.secondaryText && (imageWins || !isOrderedEvidencePolicy(state.manifest.evidencePolicy));
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
