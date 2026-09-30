import { defineErrors } from "@crawl-automation/platform";

/** What the Swanson page reader can refuse; each code becomes the product's Review code. */
export const swansonErrors = defineErrors({
  "SWANSON.VARIANT_ENUMERATION_UNVERIFIED": {
    category: "SOURCE",
    message: "The complete set of variants could not be verified.",
  },

  "SWANSON.ACCESS_CHALLENGE": {
    category: "SOURCE",
    message: "Swanson returned an access challenge instead of a product page.",
  },
  "SWANSON.PRODUCT_TEMPLATE": {
    category: "SOURCE",
    message: "The product page does not contain exactly one product heading.",
  },
  "SWANSON.STATIC_PARSE_FAILED": {
    category: "PROCESSING",
    message: "The saved Swanson HTML could not be read as a product projection.",
  },
  "SWANSON.PRODUCT_URL_UNVERIFIED": {
    category: "SOURCE",
    message: "The address is not a Swanson product page (/p/<handle>, optional ?variant=<id>).",
  },
  "SWANSON.IDENTITY_UNVERIFIED": {
    category: "IDENTITY",
    message: "The page does not show exactly one selected product and variant.",
  },
  "SWANSON.IDENTITY_CONFLICT": {
    category: "IDENTITY",
    message: "The page's own address or canonical link names another product.",
  },
  "SWANSON.VARIANT_CONFLICT": {
    category: "IDENTITY",
    message: "The page's selected variant is not the one asked for.",
  },
  "SWANSON.VARIANT_OPTIONS_UNVERIFIED": {
    category: "SOURCE",
    message: "The size/flavour picker cannot be read unambiguously.",
  },
  "SWANSON.AMBIGUOUS_FACTS": {
    category: "PROCESSING",
    message: "The page shows the same facts section twice.",
  },
});
