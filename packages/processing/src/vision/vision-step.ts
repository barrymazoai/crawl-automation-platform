import { errorCodeOf, isAppError, type ObjectStore } from "@crawl-automation/platform";
import type { ArtifactResolver } from "@crawl-automation/v3-artifacts";
import {
  VisionTaskSchema,
  type KeywordResult,
  type ReviewRecord,
  type VisionRecord,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import type { ReviewReader, ReviewWriter } from "../step/review-ledger.js";
import { encodeJson } from "../results/result-record.js";
import { writeOnce } from "../results/write-once.js";
import { ProcessingStep, type StepAttempt, type StepFailure } from "../step/processing-step.js";
import { codexFactOf } from "../codex/codex-errors.js";
import { recordedFact, type ExecutionFact } from "../step/step-failure.js";
import type { VisionModel } from "./codex-vision-model.js";
import { MAX_VISION_ANSWER_BYTES } from "./protocol/vision-limits.js";
import { visionCandidateSchema } from "./protocol/vision-protocol.js";
import { claimVisionIntent, keepCallFailure } from "./vision-attempts.js";
import { isVisionErrorCode, visionFailure } from "./vision-errors.js";
import { decodeAnswer } from "./vision-evidence.js";
import { visionKeys, visionResponse } from "./vision-files.js";
import type { VisionOutcome } from "./vision-outcome.js";
import { visionReview } from "./vision-review.js";
import type { VisionOutput, VisionResults } from "./vision-results.js";
import { retentionSignal } from "../step/retention.js";

export interface VisionStepDeps {
  model: Pick<VisionModel, "fingerprint" | "extractionProtocol" | "interpret">;
  results: VisionResults;
  /** The OCR text a keyword selection was made from, checked against the selection. */
  ocrText: { verifiedText(selection: KeywordResult, signal: AbortSignal): Promise<string> };
  artifacts: Pick<ArtifactResolver, "resolve">;
  local: ObjectStore;
  remote: ObjectStore;
  reviews: ReviewWriter & ReviewReader;
  /** "register" writes the ledger; "upload-only" (cloud mode) leaves registration to the receipt step. */
  mode?: "register" | "upload-only";
}

export type { VisionOutcome } from "./vision-outcome.js";

const handoffCodes = {
  incomplete: "VISION.HANDOFF_PENDING",
  unknown: "VISION.HANDOFF_UNKNOWN",
  reviewUnknown: "VISION.REVIEW_UNVERIFIED",
} as const;
/** The vision step: reads one selected label image with the model once and keeps its answer as the vision result. */
export class VisionStep extends ProcessingStep<
  VisionTask,
  VisionOutput,
  VisionRecord,
  VisionOutcome,
  Uint8Array
> {
  constructor(private readonly deps: VisionStepDeps) {
    super(deps);
  }

  /** The task must be valid and for exactly the vision setup this worker runs. */
  protected admit(raw: unknown): VisionTask {
    const parsed = VisionTaskSchema.safeParse(raw);
    if (!parsed.success) {
      throw visionFailure("VISION.INVALID_INPUT", "not_executed", parsed.error);
    }
    const { model } = this.deps;
    const task = parsed.data;
    if (
      task.configFingerprint !== model.fingerprint ||
      task.input.extractionProtocol !== model.extractionProtocol
    ) {
      throw visionFailure("VISION.CONFIG_MISMATCH", "not_executed");
    }
    return task;
  }

  /** The OCR selection re-checked (never a caller's "matched" flag), then the image's own bytes. */
  protected async readEvidence(task: VisionTask, signal: AbortSignal): Promise<Uint8Array> {
    const { selection } = task.input;
    try {
      await this.deps.ocrText.verifiedText(selection, signal);
      const image = await this.deps.artifacts.resolve(
        selection.image,
        selection.observation,
        signal,
      );
      return image.bytes;
    } catch (error) {
      throw visionFailure("VISION.EVIDENCE_UNRESOLVED", "not_executed", error);
    }
  }

  protected claim(task: VisionTask, signal: AbortSignal): Promise<void> {
    return claimVisionIntent(this.deps, task, signal);
  }

  /** The one model call: the raw answer is kept locally, then in R2, before it is decoded and judged. */
  protected async call(attempt: StepAttempt<VisionTask>, image: Uint8Array, signal: AbortSignal) {
    const task = attempt.input;
    const raw = await this.interpret(task, image, signal);
    attempt.fact = "executed";
    if (Buffer.byteLength(raw) > MAX_VISION_ANSWER_BYTES) {
      throw visionFailure("VISION.OUTPUT_LIMIT", "executed");
    }
    const bytes = encodeJson(visionResponse(task, raw));
    await this.keepAnswer(task, bytes);
    const decoded = readAnswer(task, raw);
    if (decoded.answer) {
      const schema = visionCandidateSchema(task.input.extractionProtocol);
      attempt.candidate = { schema, value: decoded.answer.candidate };
    }
    // Every answer goes to R2, an unreadable or rejected one included, so its Review can be inspected.
    await this.publishAnswer(task, bytes, signal);
    if (!decoded.answer) {
      throw decoded.error;
    }
    if (decoded.answer.status === "review") {
      const code = decoded.answer.code;
      throw visionFailure(
        code && isVisionErrorCode(code) ? code : "VISION.INVALID_OUTPUT",
        "executed",
      );
    }
    return { bytes, status: decoded.answer.status };
  }

  protected settled(task: VisionTask, record: VisionRecord, registered: boolean): VisionOutcome {
    const status = registered ? ("registered" as const) : ("uploaded" as const);
    const { result, completion } = record;
    const evidenceKey = result.objectKey;
    const operationId = task.input.operationId;
    return { status, operationId, candidateStatus: record.status, result, completion, evidenceKey };
  }

  /** The failure's own code when it has one; otherwise cancelled or unresolved. */
  protected classify(error: unknown, aborted: boolean) {
    const fallback = aborted ? "VISION.CANCELLED" : "VISION.UNRESOLVED";
    return { code: errorCodeOf(error) ?? fallback, fact: factOf(error) };
  }

  protected review(attempt: StepAttempt<VisionTask>, failure: StepFailure): ReviewRecord {
    return visionReview(attempt, failure);
  }

  protected reviewed(task: VisionTask, review: ReviewRecord): VisionOutcome {
    const { reviewId, failure } = review;
    const operationId = task.input.operationId;
    return {
      status: "review",
      operationId,
      reviewId,
      code: failure.code,
      evidenceKey: failure.evidenceKey,
      automaticRetry: false,
    };
  }

  protected fail(reason: keyof typeof handoffCodes, fact?: ExecutionFact) {
    return visionFailure(handoffCodes[reason], fact);
  }

  /** A failed call keeps its facts locally first, so a redelivery reports the same failure. */
  private async interpret(
    task: VisionTask,
    image: Uint8Array,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      return await this.deps.model.interpret(task.input.selection.image, image, signal);
    } catch (error) {
      await keepCallFailure(this.deps.local, task, error);
      throw error;
    }
  }

  /** Kept even after a late cancellation: the answer exists and must not be lost. */
  private keepAnswer(task: VisionTask, bytes: Uint8Array): Promise<void> {
    const entry = { key: visionKeys.response(task), bytes };
    const mismatch = () => visionFailure("VISION.LOCAL_EVIDENCE_CONFLICT", "executed");
    return writeOnce(this.deps.local, entry, {
      signal: retentionSignal(),
      mismatch,
    });
  }

  /** Written once to R2 and read back; an unconfirmed upload leaves the answer pending (kept locally), never lost. */
  private async publishAnswer(
    task: VisionTask,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const entry = { key: visionKeys.response(task), bytes };
    const mismatch = () => visionFailure("VISION.HANDOFF_PENDING", "executed");
    try {
      await writeOnce(this.deps.remote, entry, { signal, mismatch });
    } catch (error) {
      const own = errorCodeOf(error)?.startsWith("VISION.");
      throw own ? error : visionFailure("VISION.HANDOFF_PENDING", "executed", error);
    }
  }
}

/** The decoded answer, or the reason it cannot be read. */
function readAnswer(task: VisionTask, raw: string) {
  try {
    return { answer: decodeAnswer(task, raw), error: null };
  } catch (error) {
    return { answer: null, error };
  }
}

/** A Codex or vision failure says what it recorded; a local-store failure never shows the model did not run. */
function factOf(error: unknown): ExecutionFact | null {
  const codex = codexFactOf(error);
  if (codex || !isAppError(error)) {
    return codex;
  }
  return error.code.startsWith("STORAGE.") ? "unknown" : recordedFact(error);
}
