import { randomUUID } from "node:crypto";
import { errorCodeOf, isAppError, type ObjectStore } from "@crawl-automation/platform";
import type { ArtifactResolver } from "@crawl-automation/platform";
import {
  OcrIntentSchema,
  OcrOutputSchema,
  assertOcrCompatibility,
  observationIdentity,
  processingIdentity,
  type OcrActivityOutcome,
  type OcrInput,
  type OcrOutput,
  type OcrRegistration,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import type { ReviewReader, ReviewWriter } from "../step/review-ledger.js";
import { claimIntent, type IntentFailure } from "../step/intent-claim.js";
import { ProcessingStep, type StepAttempt, type StepFailure } from "../step/processing-step.js";
import { recordedFact, type ExecutionFact } from "../step/step-failure.js";
import { buildStepReview, newReviewId } from "../step/step-review.js";
import type { OcrApi } from "./ocr-api.js";
import { ocrFailure, type OcrErrorCode } from "./ocr-errors.js";
import { ocrKeys, ocrLimits, parseOcrTask } from "./ocr-kind.js";
import type { OcrResults } from "./ocr-results.js";

export interface OcrStepDeps {
  api: Pick<OcrApi, "provider" | "supported" | "recognize">;
  /** Reads the image (a local copy, or R2) and checks it against its reference. */
  artifacts: Pick<ArtifactResolver, "resolve">;
  results: OcrResults;
  remote: ObjectStore;
  reviews: ReviewWriter & ReviewReader;
  nodeId: string;
  storageId: string;
  /** "register" writes the ledger; "upload-only" (cloud mode) leaves registration to the receipt step. */
  mode?: "register" | "upload-only";
}

const intentCodes: Record<IntentFailure, OcrErrorCode> = {
  intentUnknown: "OCR.INTENT_UNKNOWN",
  intentConflict: "OCR.INTENT_CONFLICT",
  executionUnknown: "OCR.EXECUTION_UNKNOWN",
};
const handoffCodes = {
  incomplete: "OCR.HANDOFF_INCOMPLETE",
  unknown: "OCR.HANDOFF_INCOMPLETE",
  reviewUnknown: "OCR.REVIEW_UNKNOWN",
} as const;

/** The OCR step: sends one image to the OCR API once and keeps its answer as the OCR result. */
export class OcrStep extends ProcessingStep<
  OcrInput,
  OcrOutput,
  OcrRegistration,
  OcrActivityOutcome,
  Uint8Array
> {
  constructor(private readonly deps: OcrStepDeps) {
    super(deps);
  }

  protected admit(raw: unknown): OcrInput {
    try {
      const input = parseOcrTask(raw);
      assertOcrCompatibility(input, this.deps.api.supported);
      if (input.resultSchemaVersion !== 2) {
        throw ocrFailure("OCR.INVALID_INPUT", "not_executed");
      }
      return input;
    } catch (error) {
      throw ocrFailure("OCR.INVALID_INPUT", "not_executed", error);
    }
  }

  protected async readEvidence(input: OcrInput, signal: AbortSignal): Promise<Uint8Array> {
    const image = await this.deps.artifacts.resolve(input.file, observationIdentity(input), signal);
    return image.bytes;
  }

  protected claim(input: OcrInput, signal: AbortSignal): Promise<void> {
    const { nodeId, storageId } = this.deps;
    const intent = OcrIntentSchema.parse({
      schemaVersion: 1,
      input,
      nonce: randomUUID(),
      nodeId,
      storageId,
      createdAt: new Date().toISOString(),
    });
    const key = ocrKeys.intent(input);
    const fail = (reason: IntentFailure) => ocrFailure(intentCodes[reason]);
    const claim = { store: this.deps.remote, key, intent, parse: OcrIntentSchema.parse, fail };
    return claimIntent({ ...claim, limit: ocrLimits.intentBytes }, signal);
  }

  protected async call(attempt: StepAttempt<OcrInput>, image: Uint8Array, signal: AbortSignal) {
    const { input } = attempt;
    const answer = await this.deps.api.recognize(input.file, image, signal);
    attempt.fact = "executed";
    const output = OcrOutputSchema.parse({
      ...processingIdentity(input),
      text: answer.text,
      rawResponse: answer,
      provider: this.deps.api.provider,
    });
    // Accepted results stay small enough to be a Review's candidate as well.
    if (Buffer.byteLength(JSON.stringify(output)) > ocrLimits.resultBytes) {
      throw ocrFailure("OCR.OUTPUT_LIMIT", "executed");
    }
    attempt.candidate = { schema: `ocr-output/${output.resultSchemaVersion}`, value: output };
    return output;
  }

  protected settled(
    input: OcrInput,
    record: OcrRegistration,
    registered: boolean,
  ): OcrActivityOutcome {
    const files = {
      operationId: input.operationId,
      result: record.result,
      completion: record.completion,
    };
    return registered
      ? { status: "registered", ...files, resultRegistered: true }
      : { status: "uploaded", ...files, resultRegistered: false };
  }

  /** The failure's own code (OCR's, the stores', or any other coded error); otherwise cancelled or unclassified. */
  protected classify(error: unknown, aborted: boolean) {
    const fallback = aborted ? "OCR.CANCELLED" : "OCR.UNCLASSIFIED";
    return { code: errorCodeOf(error) ?? fallback, fact: factOf(error) };
  }

  protected review(attempt: StepAttempt<OcrInput>, failure: StepFailure): ReviewRecord {
    const { input } = attempt;
    const { code, fact } = failure;
    return buildStepReview({
      reviewId: newReviewId("ocr"),
      task: input,
      observation: observationIdentity(input),
      stage: "ocr.file",
      category: code.startsWith("ARTIFACT.") ? "ARTIFACT" : "PROCESSING",
      code,
      fact,
      evidenceKey: ocrKeys.intent(input),
      blockedBy: null,
      error: { name: "OcrStageFailure", details: { code, executionFact: fact } },
      candidate: attempt.candidate,
      inspection: { kind: "ocr-result", input },
    });
  }

  protected reviewed(input: OcrInput, review: ReviewRecord): OcrActivityOutcome {
    const { reviewId, failure } = review;
    const { code, evidenceKey } = failure;
    return {
      status: "review",
      operationId: input.operationId,
      reviewId,
      code,
      evidenceKey,
      automaticRetry: false,
    };
  }

  protected fail(reason: keyof typeof handoffCodes, fact?: ExecutionFact) {
    return ocrFailure(handoffCodes[reason], fact);
  }
}

/** A local-store failure never shows OCR did not run; an OCR failure says what it recorded. */
function factOf(error: unknown): ExecutionFact | null {
  if (!isAppError(error)) {
    return null;
  }
  if (error.code.startsWith("STORAGE.")) {
    return "unknown";
  }
  return recordedFact(error);
}
