import { defineErrors } from "@crawl-automation/platform";

/** Invalid role or permit settings stop the worker before polling. */
export const resourceErrors = defineErrors({
  "WORKER.ROLE_SETTINGS_MISSING": {
    category: "VALIDATION",
    message:
      "A worker role requires a settings section that is missing from this machine's config.",
  },
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
