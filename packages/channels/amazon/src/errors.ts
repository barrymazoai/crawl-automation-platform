import { defineErrors } from "@crawl-automation/platform";

export const amazonErrors = defineErrors({
  "AMAZON.STORE_UNVERIFIED": {
    category: "SOURCE",
    message: "The page has no verified Amazon Store navigation.",
  },
  "AMAZON.STORE_REDIRECT": {
    category: "SOURCE",
    message: "The browser left the requested Amazon Store sub-page.",
  },
  "AMAZON.SCAN_FILTER_LOST": {
    category: "SOURCE",
    message: "The search page no longer has the requested Brand filter selected.",
  },
  "AMAZON.SCAN_UNVERIFIED": {
    category: "SOURCE",
    message: "The response does not contain an Amazon search result grid.",
  },
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
