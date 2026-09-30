import { defineErrors } from "@crawl-automation/platform";

export const platformPageErrors = defineErrors({
  "DTC.IDENTITY_UNVERIFIED": {
    category: "IDENTITY",
    message: "The page does not identify one product and selected variant.",
  },
  "DTC.IDENTITY_CONFLICT": {
    category: "IDENTITY",
    message: "The page evidence belongs to another product or site.",
  },
  "DTC.PRODUCT_MISSING": { category: "SOURCE", message: "No readable product data on the page." },
  "DTC.JSON_INVALID": { category: "SOURCE", message: "Embedded product JSON is invalid." },
  "DTC.PAGE_LIMIT": { category: "SOURCE", message: "The page exceeds the reader's limits." },
  "DTC.PLATFORM_UNVERIFIED": {
    category: "SOURCE",
    message: "The site's platform needs a browser check.",
  },
  "DTC.LISTING_UNVERIFIED": {
    category: "SOURCE",
    message: "The catalog shows neither products nor an explicit empty result.",
  },
});
