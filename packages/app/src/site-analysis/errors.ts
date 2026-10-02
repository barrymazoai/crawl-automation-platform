import { defineErrors } from "@crawl-automation/platform";
export const siteAnalysisErrors = defineErrors({
  "SITE_ANALYSIS.NOT_FOUND": { category: "VALIDATION", message: "Site analysis not found." },
  "SITE_ANALYSIS.NOT_CONFIGURED": {
    category: "RUNTIME",
    message: "Site analysis requires the DTC browser queue and permit.",
  },
  "SITE_ANALYSIS.NOT_APPLICABLE": {
    category: "VALIDATION",
    message: "Only a completed, verified analysis can create sources.",
  },
});
