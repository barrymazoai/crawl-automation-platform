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
  "LABEL.SERVINGS_PER_CONTAINER_UNCERTAIN": {
    category: "VALIDATION",
    message:
      "The formula is retained although its serving count or size is not visible or readable.",
  },
  "LABEL.AMOUNT_IN_NAME": {
    category: "VALIDATION",
    message:
      'The row\'s amount is printed inside its name ("Includes 4g Added Sugars"); no separate amount cell.',
  },
  "LABEL.FORMULA_IS_INGREDIENT_LIST": {
    category: "VALIDATION",
    message:
      "The answer's formula only repeats the printed Ingredients list; the label has no formula panel.",
  },
  "LABEL.WHOLE_LABEL_NOT_VISIBLE": {
    category: "VALIDATION",
    message:
      "The complete printed ingredient list is retained although the whole physical label is not visible.",
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
