import {
  ingredientListRelation,
  pageIngredientsIncludeActives,
  pageListWithoutFormulaRule,
  projectLabelProductCandidate,
} from "@crawl-automation/v3-contracts";
import { assemblyErrors } from "./assembly-errors.js";
import { selectedFormulaNames, type LabelEvidence, type MergeState } from "./merge-state.js";
import { warnPageYields } from "./partial-label.js";

export interface IngredientPick {
  entry: LabelEvidence;
  candidate: LabelEvidence["candidate"];
  projected: ReturnType<typeof projectLabelProductCandidate>;
  secondaryText: boolean;
}
type PageImagePair = {
  imageItems: string[];
  pageItems: string[];
  pageId: string;
  imageIsCurrent: boolean;
};

export function warnIngredients(
  state: MergeState,
  id: string,
  code:
    | "LABEL_PRODUCT.INGREDIENTS_SUBSET"
    | "LABEL_PRODUCT.INGREDIENTS_PAGE_INCLUDES_ACTIVES"
    | "LABEL_PRODUCT.INGREDIENTS_PAGE_WITHOUT_FORMULA"
    | "LABEL_PRODUCT.INGREDIENTS_PAGE_DIFFERS"
    | "LABEL_PRODUCT.INGREDIENTS_REORDERED"
    | "LABEL_PRODUCT.SOURCE_WORDING_DIFFERS"
    | "LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT",
) {
  state.warnings.push({ id, code: assemblyErrors.code(code) });
}

/** The picked source's list becomes the selected ingredients. */
export function selectPicked(state: MergeState, pick: IngredientPick, shape: string[] | null) {
  state.otherShape = shape;
  state.otherSourceId = pick.entry.id;
  state.otherIngredients = pick.projected.otherIngredients;
}

/** The page list and the image list, when the picked source and the selected one are a page and an image. */
export function pageImagePair(
  state: MergeState,
  pick: IngredientPick,
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

export function acceptPageWithActives(
  state: MergeState,
  pick: IngredientPick,
  shape: string[] | null,
): boolean {
  const pair = pageImagePair(state, pick, shape);
  if (
    !pair ||
    !pageIngredientsIncludeActives(pair.imageItems, pair.pageItems, selectedFormulaNames(state))
  ) {
    return false;
  }
  warnIngredients(state, pair.pageId, "LABEL_PRODUCT.INGREDIENTS_PAGE_INCLUDES_ACTIVES");
  if (pair.imageIsCurrent) {
    selectPicked(state, pick, shape);
  }
  return true;
}

/** An image list agrees with every earlier one (equal, reworded, reordered or a subset either way). */
function agreesWithEarlierImages(state: MergeState, id: string, shape: string[]): boolean {
  return state.imageLists.every(
    (earlier) => earlier.id === id || ingredientListRelation(earlier.shape, shape) !== "conflict",
  );
}

/** Every image list seen so far sits inside the page list. */
function pageHoldsEveryImage(state: MergeState, pageItems: string[]): boolean {
  return state.imageLists.every(
    (image) => pageListWithoutFormulaRule.check({ imageItems: image.shape, pageItems }) !== null,
  );
}

/** With no formula on any source, a page list holding every image item is the product's ingredients. */
function acceptPageWithoutFormula(
  state: MergeState,
  pick: IngredientPick,
  shape: string[] | null,
): boolean {
  const pair = state.anyFormula ? null : pageImagePair(state, pick, shape);
  if (
    !pair ||
    pageListWithoutFormulaRule.check(pair) === null ||
    !pageHoldsEveryImage(state, pair.pageItems)
  ) {
    return false;
  }
  warnIngredients(state, pair.pageId, "LABEL_PRODUCT.INGREDIENTS_PAGE_WITHOUT_FORMULA");
  if (!pair.imageIsCurrent) {
    selectPicked(state, pick, shape);
  }
  return true;
}

/**
 * A page list that differs from the list printed on the label image is not a contradiction: the image wins (owner
 * 2026-10-09 and 2026-10-25). Two images that differ remain a conflict, and an image that confirms no other
 * ingredients are printed still blocks a page that lists some.
 */
function keepImageOverPage(
  state: MergeState,
  pick: IngredientPick,
  shape: string[] | null,
): boolean {
  const pair = pageImagePair(state, pick, shape);
  if (
    !pair ||
    pair.imageItems.length === 0 ||
    (pair.imageIsCurrent && !agreesWithEarlierImages(state, pick.entry.id, pair.imageItems))
  ) {
    return false;
  }
  warnPageYields(state.warnings, pair.pageId);
  if (pair.imageIsCurrent) {
    selectPicked(state, pick, shape);
  }
  return true;
}

/** Instead of a conflict, a page/image difference resolves; false leaves it a conflict. */
export function resolvePageDifference(
  state: MergeState,
  pick: IngredientPick,
  shape: string[] | null,
): boolean {
  return acceptPageWithoutFormula(state, pick, shape) || keepImageOverPage(state, pick, shape);
}
