import { defineErrors } from "@crawl-automation/platform";

/** Non-blocking label findings, retained in collected-product warnings rather than Review codes. */
export const labelValidationWarnings = defineErrors({
  "LABEL.BLEND_WITHOUT_COMPONENTS": {
    category: "VALIDATION",
    message: "A printed blend amount is retained without separately listed components.",
  },
  "LABEL.GROUP_HEADING_ONLY": {
    category: "VALIDATION",
    message: "A heading read as a group has no components; its rows are kept as standalone rows.",
  },
  "LABEL.SERVING_SIZE_MISSING": {
    category: "VALIDATION",
    message: "The formula is kept with an empty serving size because the label prints none.",
  },
});

/** Registered reasons retained in Reviews and source observations. */
export const labelValidationErrors = defineErrors({
  "LABEL.AMOUNT_UNREADABLE": { category: "VALIDATION", message: "Amount unreadable." },
  "LABEL.CONTAINER_COUNT_CONFLICT": {
    category: "VALIDATION",
    message: "Container count conflict.",
  },
  "LABEL.CORE_MISSING": { category: "VALIDATION", message: "Core missing." },
  "LABEL.COVERAGE_UNCERTAIN": { category: "VALIDATION", message: "Coverage uncertain." },
  "LABEL.EVIDENCE_UNCERTAIN": { category: "VALIDATION", message: "Evidence uncertain." },
  "LABEL.EXTRACTION_INCOMPLETE": { category: "VALIDATION", message: "Extraction incomplete." },
  "LABEL.FORMULA_CONFLICT": { category: "VALIDATION", message: "Formula conflict." },
  "LABEL.FORMULA_INCOMPLETE": { category: "VALIDATION", message: "Formula incomplete." },
  "LABEL.INGREDIENTS_INCOMPLETE": { category: "VALIDATION", message: "Ingredients incomplete." },
  "LABEL.INGREDIENT_BOUNDARY": { category: "VALIDATION", message: "Ingredient boundary." },
  "LABEL.INGREDIENT_HEADING_INVALID": {
    category: "VALIDATION",
    message: "Ingredient heading invalid.",
  },
  "LABEL.INGREDIENT_ROLE_INVALID": { category: "VALIDATION", message: "Ingredient role invalid." },
  "LABEL.OTHER_INGREDIENTS_CONFLICT": {
    category: "VALIDATION",
    message: "Other ingredients conflict.",
  },
  "LABEL.ROW_ORDER_INVALID": { category: "VALIDATION", message: "Row order invalid." },
  "LABEL.SOURCE_NOT_COMPLETE": { category: "VALIDATION", message: "Source not complete." },
});
