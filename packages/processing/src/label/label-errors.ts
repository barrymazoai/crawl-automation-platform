import { defineErrors, type AppError } from "@crawl-automation/platform";

const artifact = (message: string) => ({ category: "ARTIFACT" as const, message });
const processing = (message: string) => ({ category: "PROCESSING" as const, message });

/**
 * Errors of label-core preparation, label plans and saved-source resolution. The codes are stored in Reviews, so they
 * keep their exact spelling. Every channel's label plan uses the `CHANNEL.LABEL_*` codes.
 */
export const labelErrors = defineErrors({
  "LABEL_CORE.IDENTITY_CONFLICT": artifact(
    "The full page document belongs to another observation.",
  ),
  "LABEL_CORE.SOURCE_UNSUPPORTED": artifact("No label-core policy reads this page's source."),
  "LABEL_CORE.HANDOFF_UNVERIFIED": artifact(
    "The label-core document in R2 could not be confirmed.",
  ),
  "LABEL_CORE.EXTRACTION_FAILED": processing(
    "The channel's label-core reader failed without a code.",
  ),
  "CHANNEL.LABEL_SOURCE_UNVERIFIED": artifact("The product's source plan is not durable."),
  "CHANNEL.LABEL_IDENTITY_CONFLICT": artifact("A label source belongs to another task."),
  "CHANNEL.LABEL_PREPARATION_UNVERIFIED": artifact("A label source was not prepared."),
  "CHANNEL.CORE_UNAVAILABLE": processing(
    "The label task needs label-core preparation, which is not set up.",
  ),
  "CHANNEL.CORE_IDENTITY_CONFLICT": artifact(
    "The label-core document is for another page or policy.",
  ),
  "CHANNEL.LABEL_SELECTION_UNAVAILABLE": processing(
    "Image-first selection is not set up for this task.",
  ),
  "CHANNEL.LABEL_SELECTION_UNVERIFIED": artifact("The image selection could not be verified."),
  "CHANNEL.LABEL_SELECTION_REQUIRED": processing("An image-first task needs an image selection."),
  "CHANNEL.LABEL_FILE_UNVERIFIED": artifact("A downloaded image is missing from R2."),
  "CHANNEL.LABEL_NO_SOURCE": processing("No source holds a label."),
  "CHANNEL.LABEL_HANDOFF_UNVERIFIED": artifact("The label manifest in R2 could not be confirmed."),
  "SAVED.PDF_ADAPTER_REQUIRED": processing("A PDF source needs the PDF text reader."),
  "SAVED.PAGE_UNCONFIRMED": artifact("The prepared page is not durable."),
  "SAVED.PAGE_INPUT_UNCONFIRMED": artifact("The page's text task is not durable."),
  "SAVED.OCR_UNCONFIRMED": artifact("The OCR result is not registered."),
  "SAVED.KEYWORDS_UNCONFIRMED": artifact("The keyword decision is not durable."),
  "SAVED.RECEIPT_INVALID": artifact("A receipt contradicts the source's evidence."),
  "SAVED.REVIEW_UNVERIFIED": artifact("A source's Review could not be found."),
  "SAVED.IDENTITY_CONFLICT": artifact("A source's Review belongs to another task."),
  "SAVED.FILE_UNCONFIRMED": artifact("The downloaded image is not durable."),
  "SAVED.FILE_INPUT_UNCONFIRMED": artifact("The image's OCR task is not durable."),
  "SAVED.PREPARATION_UNVERIFIED": artifact("A source's preparation could not be verified."),
});

export type LabelErrorCode = keyof typeof labelErrors.codes;

export const labelFailure = (code: LabelErrorCode, cause?: unknown): AppError =>
  labelErrors.create(code, cause === undefined ? {} : { cause });
