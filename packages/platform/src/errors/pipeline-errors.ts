import { defineErrors } from "./define-errors.js";

/** Registered reasons retained in Reviews and source observations. */
export const pipelineErrors = defineErrors({
  "BRAND_SCAN.UNRESOLVED": { category: "SOURCE", message: "Unresolved." },
  "CHANNEL.DEPENDENCY_UNAVAILABLE": { category: "PROCESSING", message: "Dependency unavailable." },
  "FORMULA.FAMILY_UNREADABLE": { category: "PROCESSING", message: "Family unreadable." },
  "FORMULA.LABEL_IMAGE_UNAVAILABLE": {
    category: "PROCESSING",
    message: "Label image unavailable.",
  },
  "FORMULA.LABEL_MISMATCH": { category: "PROCESSING", message: "Label mismatch." },
  "FORMULA.LABEL_TEXT_UNAVAILABLE": { category: "PROCESSING", message: "Label text unavailable." },
  "FORMULA.NO_SIBLING_FORMULA": { category: "PROCESSING", message: "No sibling formula." },
  "FORMULA.SIBLING_FORMULA_UNREADABLE": {
    category: "PROCESSING",
    message: "Sibling formula unreadable.",
  },
  "LABEL.ACTIVITY_UNKNOWN": { category: "RUNTIME", message: "Activity unknown." },
  "PIPELINE.ACTIVITY_UNRESOLVED": { category: "RUNTIME", message: "Activity unresolved." },
  "PIPELINE.BROWSER_QUEUE_MISSING": { category: "PROCESSING", message: "Browser queue missing." },
  "PIPELINE.FILE_IDENTITY": { category: "PROCESSING", message: "File identity." },
  "PIPELINE.FORMULA_PENDING": { category: "PROCESSING", message: "Formula pending." },
  "PIPELINE.PRODUCT_UNRESOLVED": { category: "PROCESSING", message: "Product unresolved." },
  "PIPELINE.RETRY_DENIED": { category: "RUNTIME", message: "Retry denied." },
  "WHOLEFOODS.AMAZON_FORMULA_MISSING": {
    category: "PROCESSING",
    message: "No formula was available for the linked Amazon product.",
  },
});
