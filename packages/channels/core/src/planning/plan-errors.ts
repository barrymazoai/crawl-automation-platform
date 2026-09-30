import { defineErrors } from "@crawl-automation/platform";

/** The formula planner's own failures; each becomes the code of the product's passive Review. */
export const planErrors = defineErrors({
  "CHANNEL.SOURCE_CONFLICT": {
    category: "ARTIFACT",
    message: "The retained page projection is not the one the plan names.",
  },
  "CHANNEL.VARIANT_CONFLICT": {
    category: "PROCESSING",
    message: "An image belongs to a different variant than the product planned.",
  },
  "CHANNEL.NO_PRODUCT_SOURCES": {
    category: "PROCESSING",
    message: "The page has neither facts text nor label images to read a formula from.",
  },
  "CHANNEL.OPERATION_CONFLICT": {
    category: "PROCESSING",
    message: "A planned task would reuse the capture's own operation ID.",
  },
  "CHANNEL.OUTPUT_LIMIT": { category: "PROCESSING", message: "The plan is larger than allowed." },
  "CHANNEL.PLAN_CONFLICT": {
    category: "ARTIFACT",
    message: "A different plan is already saved for this operation.",
  },
  "CHANNEL.NOT_DURABLE": {
    category: "ARTIFACT",
    message: "The plan or its source is not readable from R2.",
  },
  "CHANNEL.REVIEW_UNVERIFIED": {
    category: "ARTIFACT",
    message: "The planning Review could not be read back as written.",
  },
  "CHANNEL.CANCELLED": { category: "RUNTIME", message: "Planning was cancelled." },
  "CHANNEL.PLAN_UNRESOLVED": {
    category: "PROCESSING",
    message: "Planning failed without a channel error code.",
  },
  "SOURCE.SESSION_MISMATCH": {
    category: "VALIDATION",
    message: "The file download asked for is not part of the saved plan.",
  },
});
