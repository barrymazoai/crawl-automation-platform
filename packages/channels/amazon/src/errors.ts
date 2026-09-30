import { defineErrors } from "@crawl-automation/platform";

export const amazonErrors = defineErrors({
  "AMAZON.PRODUCT_UNVERIFIED": {
    category: "SOURCE",
    message: "The page does not identify one Amazon product with a title.",
  },
  "AMAZON.ASIN_CONFLICT": {
    category: "SOURCE",
    message: "The page or retained projection contains conflicting product identities.",
  },
  "AMAZON.PROJECTION_INVALID": {
    category: "SOURCE",
    message: "The retained Amazon projection is invalid.",
  },
  "AMAZON.FAMILY_CONFLICT": {
    category: "SOURCE",
    message: "The page gives conflicting variation families for the selected ASIN.",
  },
});
