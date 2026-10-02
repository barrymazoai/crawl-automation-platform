import { defineErrors } from "@crawl-automation/platform";

/** Registered reasons retained in Reviews and source observations. */
export const dtcEvidenceErrors = defineErrors({
  "DTC.BRAND_SOURCE_MISMATCH": {
    category: "IDENTITY",
    message: "The source brand does not match this configured brand catalog.",
  },
  "DTC.BRAND_SOURCE_REQUIRED": {
    category: "IDENTITY",
    message: "A multi-brand product task requires its explicitly configured brand source.",
  },
  "DTC.BRAND_MISMATCH": {
    category: "SOURCE",
    message: "The page's brand differs from the brand source; both observations are retained.",
  },
  "DTC.BRAND_UNVERIFIED": {
    category: "SOURCE",
    message: "The multi-brand product page does not identify its brand.",
  },
  "DTC.FACTS_VARIANT_UNASSIGNED": {
    category: "SOURCE",
    message: "The facts could not be assigned to a variant.",
  },
});
