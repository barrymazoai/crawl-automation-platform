import { isAppError } from "@crawl-automation/platform";
import { ocrFailure } from "./ocr-errors.js";
import type { OcrStopResult } from "./ocr-stop.js";

/** Stop proof resolves execution uncertainty, never supplies a lost OCR result or retries it. */
export function verifiedOcrFailure(error: unknown, cleanup: OcrStopResult, enabled: boolean) {
  if (!isAppError(error)) {
    return error;
  }
  error.details["cleanup"] = cleanup;
  if (!enabled || !cleanup.stopped) {
    return error;
  }
  if (error.code === "OCR.TIMEOUT") {
    error.details["executionFact"] = "executed";
  }
  if (error.code === "OCR.RESPONSE_UNKNOWN") {
    // UNKNOWN codes intentionally block source fallback even when execution is known.
    const known = ocrFailure("OCR.JOB_FAILED", "executed", error);
    known.details["cleanup"] = cleanup;
    return known;
  }
  return error;
}
