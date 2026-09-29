import {
  TextReceiptInputSchema,
  TextRecordSchema,
  parseTextInput,
  textObservation,
  type ReviewRecord,
  type TextInput,
  type TextReceiptOutcome,
  type TextRecord,
} from "@crawl-automation/v3-contracts";
import {
  ProcessingReceipt,
  registeredInputIs,
  type ReceiptDeps,
  type ReceiptFailureReason,
  type ReceiptKind,
} from "../../step/processing-receipt.js";
import { hashText } from "../results/text-record.js";
import { receiptFailure, type TextReceiptErrorCode } from "./receipt-errors.js";

const codes: Record<ReceiptFailureReason, TextReceiptErrorCode> = {
  identityConflict: "TEXT_RECEIPT.IDENTITY_CONFLICT",
  reviewUnverified: "TEXT_RECEIPT.REVIEW_UNVERIFIED",
  resultUnconfirmed: "TEXT_RECEIPT.TEXT_UNCONFIRMED",
  evidenceUnverified: "TEXT_RECEIPT.EVIDENCE_UNVERIFIED",
  localUnverified: "TEXT_RECEIPT.LOCAL_UNVERIFIED",
};

const textReceiptKind: ReceiptKind<TextInput, TextRecord, TextReceiptOutcome> = {
  parseRequest: (raw) => {
    const request = TextReceiptInputSchema.parse(raw);
    return { input: parseTextInput(request.input, hashText), outcome: request.outcome };
  },
  parseRecord: (raw) => TextRecordSchema.parse(raw),
  task: (input) => input,
  ownsRegistration: registeredInputIs,
  reviewedStage: "codex.text",
  observation: textObservation,
  ownsReview: () => true,
  reviewReceipt: (input: TextInput, review: ReviewRecord) => ({
    status: "review",
    operationId: input.operationId,
    reviewId: review.reviewId,
    code: review.failure.code,
    automaticRetry: false,
  }),
  registeredReceipt: (registration) => ({ status: "registered", registration }),
  failureReview: {
    stage: "text.receipt",
    idPrefix: "text-receipt",
    keyPrefix: "text-receipt-reviews",
    errorName: "TextReceiptFailure",
  },
  failureDetails: (input, outcome) => ({ input, outcome }),
  failureInspection: () => ({ kind: "none" }),
  codes,
  fail: (reason) => receiptFailure(codes[reason]),
};

export type TextReceiptDeps = ReceiptDeps<TextInput, TextRecord>;

/** Confirms a text task's result or Review (see ProcessingReceipt). */
export class TextReceipt extends ProcessingReceipt<TextInput, TextRecord, TextReceiptOutcome> {
  constructor(deps: TextReceiptDeps) {
    super(textReceiptKind, deps);
  }
}
