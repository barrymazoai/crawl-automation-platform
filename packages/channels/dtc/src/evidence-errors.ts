import { defineErrors } from "@crawl-automation/platform";

/** Registered reasons retained in Reviews and source observations. */
export const dtcEvidenceErrors = defineErrors({
  "DTC.FACTS_VARIANT_UNASSIGNED": {
    category: "SOURCE",
    message: "The facts could not be assigned to a variant.",
  },
});
