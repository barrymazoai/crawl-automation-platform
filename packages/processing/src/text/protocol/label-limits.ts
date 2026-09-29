import { defineErrors } from "@crawl-automation/platform";

/** Refusals before an answer is read: the answer or the text is too large, or the range is broken. */
export const labelLimitErrors = defineErrors({
  "LABEL.TEXT_LIMIT": {
    category: "PROCESSING",
    message: "The answer, the text or its range is outside the allowed limits.",
  },
  "LABEL.TEXT_RANGE": {
    category: "PROCESSING",
    message: "The text range would split a character.",
  },
});
