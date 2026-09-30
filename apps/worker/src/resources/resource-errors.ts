import { defineErrors } from "@crawl-automation/platform";

/** Worker settings whose permits do not fit the work they guard; the worker does not start. */
export const resourceErrors = defineErrors({
  "WORKER.RESOURCE_KIND_MISMATCH": {
    category: "VALIDATION",
    message:
      "A label step's permits are the wrong kind (e.g. a model call without a model permit).",
  },
  "WORKER.BROWSER_SETTINGS_MISSING": {
    category: "VALIDATION",
    message:
      "A process runs the browser role but this machine's config has no browser (Ego) settings.",
  },
});
