import { defineErrors } from "@crawl-automation/platform";

/**
 * Errors of the Review ledger. The codes are stored and compared by callers, so they keep the exact spelling the old
 * `v3-review` package used.
 */
export const reviewErrors = defineErrors({
  "REVIEW.INVALID_RECORD": {
    category: "VALIDATION",
    message: "The Review record is not valid JSON of the Review shape.",
  },
  "REVIEW.TOO_LARGE": {
    category: "VALIDATION",
    message: "The Review record is larger than allowed.",
  },
  "REVIEW.CONFLICT": {
    category: "INGEST",
    message: "A different Review is already stored under this ID.",
  },
  "REVIEW.INTEGRITY": {
    category: "INGEST",
    message: "A stored Review does not match its ID or record hash.",
  },
  "REVIEW.UNAVAILABLE": { category: "RUNTIME", message: "The Review ledger could not be reached." },
  "REVIEW.REGISTRATION_UNKNOWN": {
    category: "INGEST",
    message: "Whether the Review was stored could not be confirmed.",
  },
});

export type ReviewErrorCode = keyof typeof reviewErrors.codes;
