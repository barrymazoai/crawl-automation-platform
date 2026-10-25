import {
  ingredientListRelation,
  ingredientComparisonSize,
  ingredientsAgreement,
  isFullIngredientsHeading,
  isOrderedEvidencePolicy,
  labelAgreementIngredients,
  type IngredientRelation,
} from "@crawl-automation/v3-contracts";
import { assemblyErrors } from "./assembly-errors.js";
import type { MergeState } from "./merge-state.js";
import {
  acceptPageWithActives,
  pageImagePair,
  resolvePageDifference,
  selectPicked,
  warnIngredients as warn,
  type IngredientPick,
} from "./page-ingredient-difference.js";

type Pick = IngredientPick;
type Compared = { shape: string[] | null; relation: IngredientRelation };

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
    selectPicked(state, pick, shape);
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
  // A page that differs yields to the printed image; images that disagree, two pages, or a page against an
  // image confirming no other ingredients remain a conflict.
  const secondary = secondaryTextDifference(state, pick);
  if (secondary) {
    warn(state, pick.entry.id, "LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT");
  } else if (!resolvePageDifference(state, pick, shape)) {
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
  if (!acceptPageWithActives(state, pick, shape)) {
    compareOtherIngredients(state, pick, shape);
  }
  if (pick.entry.kind === "image" && shape?.length) {
    state.imageLists.push({ id: pick.entry.id, shape });
  }
}

function compareOtherIngredients(state: MergeState, pick: Pick, shape: string[] | null): void {
  const relation = ingredientListRelation(state.otherShape, shape);
  if (hasUnattributedPageExtras(state, pick, { shape, relation })) {
    if (!resolvePageDifference(state, pick, shape)) {
      state.codes.add(assemblyErrors.code("LABEL_PRODUCT.INGREDIENTS_CONFLICT"));
    }
    return;
  }
  if (acceptSubset(state, pick, { shape, relation })) {
    return;
  }
  if (state.otherShape || pick.secondaryText) {
    compareSelected(state, pick, { shape, relation });
  }
  if (state.otherShape === null && !pick.secondaryText) {
    selectPicked(state, pick, shape);
  }
}
