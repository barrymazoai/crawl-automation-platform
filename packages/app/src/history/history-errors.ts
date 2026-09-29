import { defineErrors } from "@crawl-automation/platform";

/** Errors of the metrics history. */
export const historyErrors = defineErrors({
  "HISTORY.CAPTURE_IDENTITY_UNRESOLVED": {
    category: "IDENTITY",
    message:
      "The captured page names no listing the history can key (no channel site or product ID).",
  },
  "HISTORY.CONTENT_CONFLICT": {
    category: "IDENTITY",
    message: "A different history record is already stored under this capture.",
  },
  "HISTORY.READBACK_MISMATCH": {
    category: "INGEST",
    message: "The history record read back differs from the one written.",
  },
});
