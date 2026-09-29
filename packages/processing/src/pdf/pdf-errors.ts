import { defineErrors, type AppError } from "@crawl-automation/platform";

const artifact = (message: string) => ({ category: "ARTIFACT" as const, message });
const processing = (message: string) => ({ category: "PROCESSING" as const, message });

/**
 * Errors of PDF evidence, page and OCR plans, and PDF text documents. The codes are stored in Reviews, so they keep
 * their exact spelling; the PDF engine raises its own `PDF.*` codes through the engine port.
 */
export const pdfErrors = defineErrors({
  "PDF.INVALID_INPUT": processing("The PDF task is invalid."),
  "PDF.ENGINE_MISMATCH": processing("The PDF task is for another PDF engine setup."),
  "PDF.INPUT_INTEGRITY": artifact("The PDF is larger than the engine accepts."),
  "PDF.RESULT_INTEGRITY": artifact("A PDF result does not match its task or engine."),
  "PDF.NOT_DURABLE": artifact("The PDF or its result is not in R2."),
  "PDF.INTENT_UNKNOWN": artifact(
    "Recording the intent to run the PDF engine could not be confirmed.",
  ),
  "PDF.EXECUTION_UNKNOWN": processing("The PDF engine may already have run for this task."),
  "PDF.ATTEMPT_UNVERIFIED": artifact("The PDF engine attempt could not be recorded locally."),
  "PDF.OUTPUT_LIMIT": artifact("A PDF evidence file is larger than allowed."),
  "PDF.REVIEW_UNVERIFIED": artifact("The PDF Review could not be confirmed."),
  "PDF.IDENTITY_CONFLICT": artifact("The PDF evidence belongs to another task."),
  "PDF.PLAN_CONFLICT": artifact("A different PDF plan is already stored."),
  "PDF.HANDOFF_PENDING": artifact("An earlier PDF publication never finished."),
  "PDF.HANDOFF_UNVERIFIED": artifact("Publishing a PDF evidence file could not be confirmed."),
  "PDF.PRODUCT_PAGE_LIMIT": processing("The PDF has more pages than a product may have."),
  "PDF.TEXT_EMPTY": processing("The PDF page has no text."),
  "PDF.TEXT_LIMIT": processing("The PDF page text is longer than allowed."),
  "PDF.TEXT_INPUT_UNVERIFIED": artifact("The PDF page's text task is not durable."),
  "PDF.UNRESOLVED": processing("The PDF step failed for an unrecorded reason."),
});

export type PdfErrorCode = keyof typeof pdfErrors.codes;

export const pdfFailure = (code: PdfErrorCode, cause?: unknown): AppError =>
  pdfErrors.create(code, cause === undefined ? {} : { cause });
