import { defineErrors } from "@crawl-automation/platform";

/** Errors of choosing which roles a started worker process runs. */
export const processErrors = defineErrors({
  "WORKER.UNKNOWN_PROCESS": {
    category: "RUNTIME",
    message: "The machine config names no process by that name.",
  },
});
