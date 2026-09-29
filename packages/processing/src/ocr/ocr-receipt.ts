import { isDeepStrictEqual } from "node:util";
import {
  OcrReceiptInputSchema,
  OcrRegistrationSchema,
  observationIdentity,
  type OcrInput,
  type OcrReceiptOutcome,
  type OcrRegistration,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import {
  ProcessingReceipt,
  registeredInputIs,
  type ReceiptDeps,
  type ReceiptFailureReason,
  type ReceiptKind,
} from "../step/processing-receipt.js";
import { ocrFailure, type OcrErrorCode } from "./ocr-errors.js";
import { parseOcrTask } from "./ocr-kind.js";

const codes: Record<ReceiptFailureReason, OcrErrorCode> = {
  identityConflict: "RECEIPT.IDENTITY_CONFLICT",
  reviewUnverified: "RECEIPT.REVIEW_UNVERIFIED",
  resultUnconfirmed: "RECEIPT.OCR_UNCONFIRMED",
  evidenceUnverified: "RECEIPT.EVIDENCE_UNVERIFIED",
  localUnverified: "RECEIPT.LOCAL_UNVERIFIED",
};

const ocrReceiptKind: ReceiptKind<OcrInput, OcrRegistration, OcrReceiptOutcome> = {
  parseRequest: (raw) => {
    const request = OcrReceiptInputSchema.parse(raw);
    return { input: parseOcrTask(request.input), outcome: request.outcome };
  },
  parseRecord: (raw) => OcrRegistrationSchema.parse(raw),
  task: (input) => input,
  ownsRegistration: registeredInputIs,
  reviewedStage: "ocr.file",
  observation: observationIdentity,
  ownsReview: (review, input, outcome) =>
    review.failure.evidenceKey === outcome.evidenceKey &&
    isDeepStrictEqual(review.inspection, { kind: "ocr-result", input }),
  reviewReceipt: (input: OcrInput, review: ReviewRecord) => ({
    status: "review",
    imageId: input.file.artifactId,
    operationId: input.operationId,
    reviewId: review.reviewId,
    code: review.failure.code,
    automaticRetry: false,
  }),
  registeredReceipt: (registration) => ({ status: "registered", registration }),
  failureReview: {
    stage: "ocr.receipt",
    idPrefix: "receipt",
    keyPrefix: "ocr-receipt-reviews",
    errorName: "OcrReceiptFailure",
  },
  failureDetails: (_input, outcome) => ({ outcome }),
  failureInspection: (input) => ({ kind: "ocr-result", input }),
  codes,
  fail: (reason) => ocrFailure(codes[reason]),
};

export type OcrReceiptDeps = ReceiptDeps<OcrInput, OcrRegistration>;

/** Confirms an OCR task's result or Review (see ProcessingReceipt). */
export class OcrReceipt extends ProcessingReceipt<OcrInput, OcrRegistration, OcrReceiptOutcome> {
  constructor(deps: OcrReceiptDeps) {
    super(ocrReceiptKind, deps);
  }
}
