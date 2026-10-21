import {
  ingredientListRelation,
  ingredientComparisonSize,
  ingredientsAgreement,
  isOrderedEvidencePolicy,
  labelAgreementIngredients,
  projectLabelProductCandidate,
  type IngredientRelation,
} from "@crawl-automation/v3-contracts";
import { assemblyErrors } from "./assembly-errors.js";
import type { LabelEvidence, MergeState } from "./merge-state.js";

interface Pick {
  entry: LabelEvidence;
  candidate: LabelEvidence["candidate"];
  projected: ReturnType<typeof projectLabelProductCandidate>;
  secondaryText: boolean;
}
type Compared = { shape: string[] | null; relation: IngredientRelation };

function warn(
  state: MergeState,
  id: string,
  code:
    | "LABEL_PRODUCT.INGREDIENTS_SUBSET"
    | "LABEL_PRODUCT.INGREDIENTS_REORDERED"
    | "LABEL_PRODUCT.SOURCE_WORDING_DIFFERS"
    | "LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT",
) {
  state.warnings.push({ id, code: assemblyErrors.code(code) });
}

function acceptSubset(state: MergeState, pick: Pick, compared: Compared): boolean {
  const { shape, relation } = compared;
  if (relation !== "subset" || state.otherShape === null || shape === null) {
    return false;
  }
  const longer = ingredientComparisonSize(state.otherShape) < ingredientComparisonSize(shape);
  const shorterId = longer ? state.otherSourceId : pick.entry.id;
  if (shorterId) {
    warn(state, shorterId, "LABEL_PRODUCT.INGREDIENTS_SUBSET");
  }
  if (longer && !pick.secondaryText) {
    state.otherShape = shape;
    state.otherSourceId = pick.entry.id;
    state.otherIngredients = pick.projected.otherIngredients;
  }
  return true;
}

function compareSelected(state: MergeState, pick: Pick, compared: Compared): void {
  const { shape, relation } = compared;
  if (relation === "reordered" && !pick.secondaryText) {
    warn(state, pick.entry.id, "LABEL_PRODUCT.INGREDIENTS_REORDERED");
    return;
  }
  const agreement = ingredientsAgreement(
    state.otherShape,
    shape,
    state.manifest.admission?.comparison,
  );
  if (agreement === "exact") {
    return;
  }
  if (agreement === "wording") {
    warn(state, pick.entry.id, "LABEL_PRODUCT.SOURCE_WORDING_DIFFERS");
    return;
  }
  // A complete image wins over page text; ordered policies still block contrary page evidence.
  const secondary =
    pick.secondaryText &&
    (!!state.otherIngredients || !isOrderedEvidencePolicy(state.manifest.evidencePolicy));
  if (secondary) {
    warn(state, pick.entry.id, "LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT");
  } else {
    state.codes.add(assemblyErrors.code("LABEL_PRODUCT.INGREDIENTS_CONFLICT"));
  }
}

/** Select the longest verified list when another source is an exact item subset. */
export function selectOtherIngredients(state: MergeState, pick: Pick): void {
  if (!pick.candidate.otherIngredients && !labelAgreementIngredients(pick.candidate)) {
    return;
  }
  const shape = labelAgreementIngredients(pick.candidate);
  const relation = ingredientListRelation(state.otherShape, shape);
  if (acceptSubset(state, pick, { shape, relation })) {
    return;
  }
  if (state.otherShape || pick.secondaryText) {
    compareSelected(state, pick, { shape, relation });
  }
  if (state.otherShape === null && !pick.secondaryText) {
    state.otherShape = shape;
    state.otherSourceId = pick.entry.id;
    state.otherIngredients = pick.projected.otherIngredients;
  }
}
