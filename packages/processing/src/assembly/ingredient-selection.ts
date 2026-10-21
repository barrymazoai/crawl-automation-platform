import {
  ingredientListRelation,
  ingredientComparisonSize,
  ingredientsAgreement,
  isFullIngredientsHeading,
  isOrderedEvidencePolicy,
  labelAgreementIngredients,
  pageIngredientsIncludeActives,
  projectLabelProductCandidate,
  type IngredientRelation,
} from "@crawl-automation/v3-contracts";
import { assemblyErrors } from "./assembly-errors.js";
import { selectedFormulaNames, type LabelEvidence, type MergeState } from "./merge-state.js";

interface Pick {
  entry: LabelEvidence;
  candidate: LabelEvidence["candidate"];
  projected: ReturnType<typeof projectLabelProductCandidate>;
  secondaryText: boolean;
}
type Compared = { shape: string[] | null; relation: IngredientRelation };
type PageImagePair = {
  imageItems: string[];
  pageItems: string[];
  pageId: string;
  imageIsCurrent: boolean;
};

function warn(
  state: MergeState,
  id: string,
  code:
    | "LABEL_PRODUCT.INGREDIENTS_SUBSET"
    | "LABEL_PRODUCT.INGREDIENTS_PAGE_INCLUDES_ACTIVES"
    | "LABEL_PRODUCT.INGREDIENTS_REORDERED"
    | "LABEL_PRODUCT.SOURCE_WORDING_DIFFERS"
    | "LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT",
) {
  state.warnings.push({ id, code: assemblyErrors.code(code) });
}

function pageImagePair(
  state: MergeState,
  pick: Pick,
  shape: string[] | null,
): PageImagePair | null {
  if (state.otherSourceId === null || state.otherShape === null || shape === null) {
    return null;
  }
  const selectedKind = state.sources.get(state.otherSourceId)?.kind;
  if (pick.entry.kind === "text" && selectedKind === "image") {
    return {
      imageItems: state.otherShape,
      pageItems: shape,
      pageId: pick.entry.id,
      imageIsCurrent: false,
    };
  }
  if (pick.entry.kind === "image" && selectedKind === "text") {
    return {
      imageItems: shape,
      pageItems: state.otherShape,
      pageId: state.otherSourceId,
      imageIsCurrent: true,
    };
  }
  return null;
}

function acceptPageWithActives(state: MergeState, pick: Pick, shape: string[] | null): boolean {
  const pair = pageImagePair(state, pick, shape);
  if (
    !pair ||
    !pageIngredientsIncludeActives(pair.imageItems, pair.pageItems, selectedFormulaNames(state))
  ) {
    return false;
  }
  warn(state, pair.pageId, "LABEL_PRODUCT.INGREDIENTS_PAGE_INCLUDES_ACTIVES");
  if (pair.imageIsCurrent) {
    state.otherShape = shape;
    state.otherSourceId = pick.entry.id;
    state.otherIngredients = pick.projected.otherIngredients;
  }
  return true;
}

function hasUnattributedPageExtras(state: MergeState, pick: Pick, compared: Compared): boolean {
  const pair = pageImagePair(state, pick, compared.shape);
  return (
    pair !== null &&
    pair.pageId === pick.entry.id &&
    isFullIngredientsHeading(pick.candidate.otherIngredients?.heading.text) &&
    compared.relation === "subset" &&
    ingredientComparisonSize(pair.imageItems) < ingredientComparisonSize(pair.pageItems)
  );
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
  // A full page Ingredients list with unexplained items remains a conflict.
  const secondary = secondaryTextDifference(state, pick);
  if (secondary) {
    warn(state, pick.entry.id, "LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT");
  } else {
    state.codes.add(assemblyErrors.code("LABEL_PRODUCT.INGREDIENTS_CONFLICT"));
  }
}

function secondaryTextDifference(state: MergeState, pick: Pick): boolean {
  return (
    pick.secondaryText &&
    !isFullIngredientsHeading(pick.candidate.otherIngredients?.heading.text) &&
    (!!state.otherIngredients || !isOrderedEvidencePolicy(state.manifest.evidencePolicy))
  );
}

/** Select the longest verified list when another source is an exact item subset. */
export function selectOtherIngredients(state: MergeState, pick: Pick): void {
  if (!pick.candidate.otherIngredients && !labelAgreementIngredients(pick.candidate)) {
    return;
  }
  const shape = labelAgreementIngredients(pick.candidate);
  if (acceptPageWithActives(state, pick, shape)) {
    return;
  }
  compareOtherIngredients(state, pick, shape);
}

function compareOtherIngredients(state: MergeState, pick: Pick, shape: string[] | null): void {
  const relation = ingredientListRelation(state.otherShape, shape);
  if (hasUnattributedPageExtras(state, pick, { shape, relation })) {
    state.codes.add(assemblyErrors.code("LABEL_PRODUCT.INGREDIENTS_CONFLICT"));
    return;
  }
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
