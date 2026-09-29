import { defineErrors } from "@crawl-automation/platform";

/** Errors raised by the worker host itself. */
export const workerErrors = defineErrors({
  "WORKER.WORKFLOW_REQUIRED": {
    category: "RUNTIME",
    message: "This activity must be called from a workflow.",
  },
  "WORKER.PROCESSING_SETTINGS_MISSING": {
    category: "RUNTIME",
    message:
      "This worker's config has no settings for this label step (Codex, OCR API or processing).",
  },
});
