import { isDeepStrictEqual } from "node:util";
import { defineErrors } from "@crawl-automation/platform";
import {
  VisionRecordSchema,
  type ReviewRecord,
  type VisionRecord,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import {
  ProcessingReceipt,
  type ReceiptDeps,
  type ReceiptFailureReason,
  type ReceiptKind,
} from "../step/processing-receipt.js";
import { visionTaskFingerprint } from "./vision-files.js";
import { VisionReceiptInputSchema } from "./vision-outcome.js";

const artifact = (message: string) => ({ category: "ARTIFACT" as const, message });

/** Errors of the vision receipt. Its Review keeps the code; any other failure is EVIDENCE_UNVERIFIED. */
export const visionReceiptErrors = defineErrors({
  "VISION_RECEIPT.IDENTITY_CONFLICT": artifact("The receipt belongs to a different vision task."),
  "VISION_RECEIPT.REVIEW_UNVERIFIED": artifact("The vision Review could not be confirmed."),
  "VISION_RECEIPT.RESULT_UNCONFIRMED": artifact("The vision result is not registered and durable."),
  "VISION_RECEIPT.EVIDENCE_UNVERIFIED": artifact("The vision evidence could not be verified."),
  "VISION_RECEIPT.LOCAL_UNVERIFIED": artifact(
    "The receipt's own Review could not be kept locally.",
  ),
});
type VisionReceiptCode = keyof typeof visionReceiptErrors.codes;

const codes: Record<ReceiptFailureReason, VisionReceiptCode> = {
  identityConflict: "VISION_RECEIPT.IDENTITY_CONFLICT",
  reviewUnverified: "VISION_RECEIPT.REVIEW_UNVERIFIED",
  resultUnconfirmed: "VISION_RECEIPT.RESULT_UNCONFIRMED",
  evidenceUnverified: "VISION_RECEIPT.EVIDENCE_UNVERIFIED",
  localUnverified: "VISION_RECEIPT.LOCAL_UNVERIFIED",
};

export type VisionReceiptOutcome =
  | { status: "registered"; registration: VisionRecord }
  | {
      status: "review";
      operationId: string;
      imageId: string;
      reviewId: string;
      code: string;
      automaticRetry: false;
    };

const visionReceiptKind: ReceiptKind<VisionTask, VisionRecord, VisionReceiptOutcome> = {
  parseRequest: (raw) => {
    const request = VisionReceiptInputSchema.parse(raw);
    return { input: request.task, outcome: request.outcome };
  },
  parseRecord: (raw) => VisionRecordSchema.parse(raw),
  task: (task) => {
    const owner = task.input.selection.observation;
    return {
      requestId: owner.requestId,
      observationId: owner.observationId,
      operationId: task.input.operationId,
      inputFingerprint: visionTaskFingerprint(task),
    };
  },
  ownsRegistration: (registration, task) =>
    registration.configFingerprint === task.configFingerprint &&
    isDeepStrictEqual(registration.input, task.input),
  reviewedStage: "codex.vision",
  observation: (task) => task.input.selection.observation,
  ownsReview: (review, _task, outcome) => review.failure.evidenceKey === outcome.evidenceKey,
  reviewReceipt: (task: VisionTask, review: ReviewRecord) => ({
    status: "review",
    operationId: task.input.operationId,
    imageId: task.input.selection.image.artifactId,
    reviewId: review.reviewId,
    code: review.failure.code,
    automaticRetry: false,
  }),
  registeredReceipt: (registration) => ({ status: "registered", registration }),
  failureReview: {
    stage: "vision.receipt",
    idPrefix: "vision-receipt",
    keyPrefix: "vision-receipt-reviews",
    errorName: "VisionReceiptFailure",
  },
  failureDetails: (task, outcome) => ({ task, outcome }),
  failureInspection: () => ({ kind: "none" }),
  codes,
  fail: (reason) => visionReceiptErrors.create(codes[reason]),
};

export type VisionReceiptDeps = ReceiptDeps<VisionTask, VisionRecord>;

/**
 * Confirms a vision task's result or Review (see ProcessingReceipt). New with the shared template: before it, a
 * cloud worker's vision result was registered only when a label step first read it.
 */
export class VisionReceipt extends ProcessingReceipt<
  VisionTask,
  VisionRecord,
  VisionReceiptOutcome
> {
  constructor(deps: VisionReceiptDeps) {
    super(visionReceiptKind, deps);
  }
}
