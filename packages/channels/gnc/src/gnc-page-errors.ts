import { defineErrors } from "@crawl-automation/platform";

/** What the GNC product page reader can refuse; each code becomes the product's Review code. */
export const gncPageErrors = defineErrors({
  "GNC.BRAND_MISSING": { category: "SOURCE", message: "Brand missing." },
  "GNC.FACTS_AMOUNTS_MISSING": { category: "SOURCE", message: "Facts amounts missing." },
  "GNC.FACTS_DOM_MISSING": { category: "SOURCE", message: "Facts dom missing." },
  "GNC.FACTS_OTHER_INGREDIENTS_MISSING": {
    category: "SOURCE",
    message: "Facts other ingredients missing.",
  },
  "GNC.FACTS_SERVING_SIZE_MISSING": { category: "SOURCE", message: "Facts serving size missing." },
  "GNC.FACTS_TABLE_MISSING": { category: "SOURCE", message: "Facts table missing." },
  "GNC.GALLERY_UNVERIFIED": { category: "SOURCE", message: "Gallery unverified." },

  "GNC.PAGE_LIMIT": {
    category: "SOURCE",
    message: "The page is larger or deeper than a GNC product page may be.",
  },
  "GNC.ACCESS_CHALLENGE": { category: "SOURCE", message: "GNC answered with a bot challenge." },
  "GNC.JSON_LIMIT": { category: "SOURCE", message: "The page's product data is too large." },
  "GNC.JSON_INVALID": { category: "SOURCE", message: "The page's product data is not valid JSON." },
  "GNC.SKU_UNVERIFIED": {
    category: "IDENTITY",
    message: "The page's product data does not name a verifiable SKU.",
  },
  "GNC.SKU_AMBIGUOUS": {
    category: "IDENTITY",
    message: "The page names more than one possible product record.",
  },
  "GNC.SKU_CONFLICT": {
    category: "IDENTITY",
    message: "The page or a listed size links a different SKU than it claims.",
  },
  "GNC.TITLE_MISSING": { category: "SOURCE", message: "The product has no title." },
  "GNC.DOM_AMBIGUOUS": {
    category: "SOURCE",
    message: "The page has two facts or details sections.",
  },
  "GNC.IMAGE_URL_INVALID": { category: "SOURCE", message: "An image address cannot be read." },
  "GNC.IDENTITY_CONFLICT": {
    category: "IDENTITY",
    message: "The saved projection belongs to another GNC product than the observation.",
  },
});
