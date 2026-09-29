import { defineErrors } from "@crawl-automation/platform";

/** Errors raised by the worker host itself. */
export const workerErrors = defineErrors({
  "WORKER.WORKFLOW_REQUIRED": {
    category: "RUNTIME",
    message: "This activity must be called from a workflow.",
  },
});
