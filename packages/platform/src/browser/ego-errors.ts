import { defineErrors } from "../errors/define-errors.js";

const runtime = (message: string) => ({ category: "RUNTIME" as const, message });
const source = (message: string) => ({ category: "SOURCE" as const, message });

/**
 * Errors of the Ego browser driver. A browser stop that the user caused is its own code: it is never routed around
 * by cleanup or a retry.
 */
export const egoErrors = defineErrors({
  "BROWSER.CONFIG_INVALID": runtime("The Ego browser settings are invalid."),
  "BROWSER.SPACE_MISSING": runtime("The configured Ego task space does not exist."),
  "BROWSER.UNAVAILABLE": runtime("The Ego browser could not run the task."),
  "BROWSER.USER_CONTROL": runtime(
    "The user has taken control of the browser space; the task stopped.",
  ),
  "BROWSER.TIMEOUT": runtime("The browser task did not finish in time."),
  "BROWSER.CANCELLED": runtime("The browser task was cancelled."),
  "BROWSER.PROTOCOL": runtime("The browser task answered in an unexpected form."),
  "BROWSER.PAGE_LIMIT": source("The page is larger than allowed."),
  "BROWSER.PAGE_CLEANUP_PENDING": runtime(
    "A task page was opened but its closing is not confirmed.",
  ),
});

export type EgoErrorCode = keyof typeof egoErrors.codes;
