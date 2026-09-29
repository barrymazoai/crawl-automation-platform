import { defineErrors, type AppError } from "@crawl-automation/platform";

const processing = (message: string) => ({ category: "PROCESSING" as const, message });
const artifact = (message: string) => ({ category: "ARTIFACT" as const, message });

/**
 * Errors of page preparation and page text. The codes are stored in Reviews, so they keep their exact spelling
 * (`PROCESSING.PAGE_*` from the parser, `RUNTIME.*` / `INPUT.*` from the task checks).
 */
export const pageErrors = defineErrors({
  "PROCESSING.PAGE_LIMIT": processing("The page exceeds a parsing limit."),
  "PROCESSING.PAGE_EMPTY": processing("The page has no text."),
  "RUNTIME.INCOMPATIBLE_CONSUMER": processing("The page task is for another page setup."),
  "INPUT.FINGERPRINT_MISMATCH": processing("The page task does not match its fingerprint."),
  "PAGE.IDENTITY_CONFLICT": artifact("The page evidence belongs to another task."),
  "PAGE.SOURCE_NOT_DURABLE": artifact("The captured page is not in R2."),
  "PAGE.NOT_DURABLE": artifact("The prepared page is not fully in R2."),
  "PAGE.OUTPUT_LIMIT": artifact("A prepared page file is larger than allowed."),
  "PAGE.HANDOFF_UNVERIFIED": artifact("Publishing a prepared page file could not be confirmed."),
  "PAGE.HANDOFF_PENDING": artifact("An earlier publication of this page never finished."),
  "PAGE.LOCAL_UNVERIFIED": artifact("A prepared page file could not be kept locally."),
  "PAGE.REVIEW_UNVERIFIED": artifact("The page Review could not be confirmed."),
  "PAGE.INTENT_UNKNOWN": artifact(
    "Recording the intent to prepare the page could not be confirmed.",
  ),
  "PAGE.EXECUTION_UNKNOWN": processing("The page may already have been prepared."),
  "PAGE.ENCODING": processing("The page is not valid UTF-8."),
  "PAGE.TEXT_LIMIT": processing("The page text is longer than allowed."),
  "PAGE.UNRESOLVED": processing("Page preparation failed for an unrecorded reason."),
});

export type PageErrorCode = keyof typeof pageErrors.codes;

export const pageFailure = (code: PageErrorCode, cause?: unknown): AppError =>
  pageErrors.create(code, cause === undefined ? {} : { cause });
