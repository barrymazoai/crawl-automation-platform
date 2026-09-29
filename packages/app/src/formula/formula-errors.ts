import { defineErrors } from "@crawl-automation/platform";

/** Errors of formula reuse. */
export const formulaErrors = defineErrors({
  "FORMULA.LINK_CONFLICT": {
    category: "IDENTITY",
    message: "A different formula link is already stored for this product.",
  },
});
