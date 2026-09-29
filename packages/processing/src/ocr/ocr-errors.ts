import { defineErrors, type AppError } from "@crawl-automation/platform";
import { stepFailure, type ExecutionFact } from "../step/step-failure.js";

const processing = (message: string) => ({ category: "PROCESSING" as const, message });
const artifact = (message: string) => ({ category: "ARTIFACT" as const, message });

/**
 * Errors of the OCR step, its results and its receipt. The codes are stored in Reviews, so they keep their exact
 * spelling (`OCR.*` for the step, `RESULT.*` for its stored results, `RECEIPT.*` for its receipt).
 */
export const ocrErrors = defineErrors({
  "OCR.INVALID_INPUT": processing("The OCR task is invalid or for another OCR setup."),
  "OCR.CONFIG": processing("The OCR API settings are invalid."),
  "OCR.INPUT_LIMIT": processing("The image is larger than the OCR API accepts."),
  "OCR.INPUT_INTEGRITY": artifact("The image bytes do not match their reference."),
  "OCR.CANCELLED": processing("The OCR task was cancelled."),
  "OCR.TIMEOUT": processing("The OCR API did not answer in time."),
  "OCR.RATE_LIMIT": processing("The OCR API refused the call as too many."),
  "OCR.HTTP_STATUS": processing("The OCR API answered with an error status."),
  "OCR.PROTOCOL": processing("The OCR API answer is not the expected JSON."),
  "OCR.OUTPUT_LIMIT": processing("The OCR answer is larger than allowed."),
  "OCR.RESPONSE_UNKNOWN": processing("Whether the OCR API answered is unknown."),
  "OCR.EMPTY": processing("The OCR API found no text."),
  "OCR.INTENT_UNKNOWN": artifact("Recording the intent to run OCR could not be confirmed."),
  "OCR.INTENT_CONFLICT": artifact("Another task holds this operation's intent."),
  "OCR.EXECUTION_UNKNOWN": processing("OCR may already have run for this task."),
  "OCR.HANDOFF_INCOMPLETE": artifact("The OCR result was computed but not fully stored."),
  "OCR.REVIEW_UNKNOWN": artifact("Writing the Review could not be confirmed."),
  "OCR.UNCLASSIFIED": processing("The OCR task failed for an unrecorded reason."),
  "RESULT.CONFLICT": artifact("A different OCR result is already stored for this task."),
  "RESULT.INCOMPLETE": artifact("The OCR result is not fully stored."),
  "RESULT.INTEGRITY": artifact("A stored OCR result does not match its evidence."),
  "RESULT.REGISTRATION_UNKNOWN": artifact("Registering the OCR result could not be confirmed."),
  "RESULT.NOT_DURABLE": artifact("The OCR result or its image is missing from R2."),
  "RESULT.REGISTRY_UNAVAILABLE": processing("This worker has no result registry."),
  "RECEIPT.IDENTITY_CONFLICT": artifact("The receipt belongs to a different OCR task."),
  "RECEIPT.REVIEW_UNVERIFIED": artifact("The OCR Review could not be confirmed."),
  "RECEIPT.OCR_UNCONFIRMED": artifact("The OCR result is not registered and durable."),
  "RECEIPT.EVIDENCE_UNVERIFIED": artifact("The OCR evidence could not be verified."),
  "RECEIPT.LOCAL_UNVERIFIED": artifact("The receipt's own Review could not be kept locally."),
});

export type OcrErrorCode = keyof typeof ocrErrors.codes;

/** An OCR failure that records whether the OCR API had already run and, when another error caused it, its code. */
export function ocrFailure(
  code: OcrErrorCode,
  fact: ExecutionFact = "unknown",
  cause?: unknown,
): AppError {
  return stepFailure(ocrErrors, code, { fact, cause });
}
