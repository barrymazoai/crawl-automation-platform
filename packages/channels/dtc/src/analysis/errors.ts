import { defineErrors } from "@crawl-automation/platform";
export const analysisErrors = defineErrors({
  "DTC.ANALYSIS_LIMIT": {
    category: "VALIDATION",
    message: "The bounded site analysis reached its page limit.",
  },
  "DTC.ANALYSIS_REDIRECT": {
    category: "VALIDATION",
    message: "The analysis page redirected outside its verified origin.",
  },
  "DTC.ANALYSIS_UNVERIFIED": {
    category: "VALIDATION",
    message: "Site brand data or catalog membership could not be verified.",
  },
});
