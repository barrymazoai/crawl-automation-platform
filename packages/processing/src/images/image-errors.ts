import { defineErrors } from "@crawl-automation/platform";

const artifact = (message: string) => ({ category: "ARTIFACT" as const, message });

/**
 * Errors of preparing an image's OCR task. The codes are stored in Reviews, so they keep their exact spelling; the
 * `ACQUIRE.*` ones name a problem with the download this step reads.
 */
export const imageErrors = defineErrors({
  "IMAGE.IDENTITY_CONFLICT": artifact(
    "The plan, the download and its receipt name different images.",
  ),
  "IMAGE.PDF_ROUTE_REQUIRED": artifact("The file is a PDF; it goes to PDF preparation."),
  "ACQUIRE.NOT_DURABLE": artifact("The downloaded file is not in R2."),
  "ACQUIRE.REVIEW_UNVERIFIED": artifact("The download's Review could not be confirmed."),
  "ACQUIRE.OUTPUT_LIMIT": artifact("The OCR task record is larger than allowed."),
  "ACQUIRE.HANDOFF_UNVERIFIED": artifact("Publishing the OCR task could not be confirmed."),
  "ACQUIRE.HANDOFF_PENDING": artifact("An earlier publication of the OCR task never finished."),
  "ACQUIRE.UNRESOLVED": artifact("Preparing the OCR task failed for an unrecorded reason."),
});

export type ImageErrorCode = keyof typeof imageErrors.codes;

export const imageFailure = (code: ImageErrorCode) => imageErrors.create(code);
