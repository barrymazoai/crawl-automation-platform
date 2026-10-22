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
  "DTC.CATALOG_JSON_INVALID": {
    category: "SOURCE",
    message: "The Shopify catalog response is not a valid products.json page.",
  },
  "DTC.CATALOG_HTTP_STATUS": {
    category: "SOURCE",
    message: "The Shopify catalog endpoint returned an HTTP error.",
  },
  "DTC.CATALOG_READY_TIMEOUT": {
    category: "SOURCE",
    message: "The Shopify catalog page did not become ready in time.",
  },
  "DTC.CATALOG_SCOPE_REQUIRED": {
    category: "SOURCE",
    message: "A multi-brand Shopify source must name a collection.",
  },
});
