import { ingredientComparisonKeys } from "../label-agreement.js";
import type { LabelRule } from "./rule.js";

export interface PageListSubject {
  /** The image's Other Ingredients. */
  imageItems: string[];
  /** The page's full Ingredients list. */
  pageItems: string[];
}

/**
 * With no formula anywhere, a page Ingredients list that holds every item of the image's Other Ingredients (the page
 * adds the actives) is the product's ingredients. Any other page/image difference keeps the image's list.
 */
export const pageListWithoutFormulaRule: LabelRule<PageListSubject> = {
  id: "page-list-without-formula",
  code: "LABEL_PRODUCT.INGREDIENTS_PAGE_WITHOUT_FORMULA",
  added: "2026-10-25",
  why: "Owner 2026-10-25: ingredients, health functions and form are enough, doses optional; a page that differs from the image yields to the image. 125 of 126 recapture INGREDIENTS_CONFLICT Reviews had no readable Facts image, so the page list (actives + excipients, B0CKD332ML) met the image's excipients alone; a page naming none of them (B010OV67GU; \"Antacids\" on B000OL9H36) keeps the image's list.",
  check({ imageItems, pageItems }) {
    const image = ingredientComparisonKeys(imageItems);
    const page = ingredientComparisonKeys(pageItems);
    if (!image.size || !page.size) return null;
    const shared = [...image].filter((key) => page.has(key)).length;
    return shared === image.size && image.size < page.size
      ? `the image's ${image.size} items are inside the page's ${page.size}`
      : null;
  },
};
