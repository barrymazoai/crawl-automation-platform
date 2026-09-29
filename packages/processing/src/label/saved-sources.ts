import { isDeepStrictEqual } from "node:util";
import { errorCodeOf } from "@crawl-automation/platform";
import {
  ReviewRecordSchema,
  observationIdentity,
  type ProductEvidenceJoin,
  type ReviewRecord,
  type SavedEvidenceSource,
} from "@crawl-automation/v3-contracts";
import { labelFailure } from "./label-errors.js";
import type { SourceResolution } from "./label-plan-model.js";
import { reviewedOperation } from "./saved-review-identity.js";
import { SavedSourceTasks, type SavedSourceDeps } from "./saved-source-tasks.js";

type State = ProductEvidenceJoin["states"][number];
type Of<Kind extends SavedEvidenceSource["kind"]> = Extract<SavedEvidenceSource, { kind: Kind }>;

const PREPARATION_STAGES = ["file.acquire", "image.ocr-input"];

/**
 * Reads a saved source's already produced evidence and says what it resolved to: a task, "not matched", or a Review
 * with its code. A claimed success is never taken as proof; it never prepares or runs anything.
 */
export class SavedSourceEvidence {
  private readonly tasks: SavedSourceTasks;

  constructor(private readonly deps: SavedSourceDeps) {
    this.tasks = new SavedSourceTasks(deps);
  }

  async resolve(
    source: SavedEvidenceSource,
    state: State,
    signal: AbortSignal,
  ): Promise<SourceResolution> {
    if (state.status === "rejected") {
      throw labelFailure("SAVED.RECEIPT_INVALID");
    }
    if (source.kind === "file-image") {
      return this.fileImage(source, state, signal);
    }
    if (state.status === "review") {
      return this.reviewed(source, state, signal);
    }
    return this.claimed(source, state, signal);
  }

  private async fileImage(
    source: Of<"file-image">,
    state: State,
    signal: AbortSignal,
  ): Promise<SourceResolution> {
    if (state.status === "review") {
      const review = await this.review(state.reviewId);
      if (PREPARATION_STAGES.includes(review.failure.stage)) {
        assertPreparationReview(review, { source, reviewId: state.reviewId });
        return { status: "review", code: review.failure.code };
      }
    }
    try {
      const ocrSource = await this.tasks.fileOcrSource(source, signal);
      return await this.resolve(ocrSource, state, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (state.status === "review") {
        throw error;
      }
      return { status: "review", code: "SAVED.PREPARATION_UNVERIFIED" };
    }
  }

  /** A Review of this exact source's own step, at whichever stage it stopped. */
  private async reviewed(
    source: Exclude<SavedEvidenceSource, { kind: "file-image" }>,
    state: Extract<State, { status: "review" }>,
    signal: AbortSignal,
  ): Promise<SourceResolution> {
    const review = await this.review(state.reviewId);
    if (
      review.reviewId !== state.reviewId ||
      !isDeepStrictEqual(review.observation, ownerOf(source))
    ) {
      throw labelFailure("SAVED.IDENTITY_CONFLICT");
    }
    const expected = await reviewedOperation(source, { review, tasks: this.tasks, signal });
    const { failure } = review;
    if (
      failure.operationId !== expected.operationId ||
      failure.inputFingerprint !== expected.inputFingerprint
    ) {
      throw labelFailure("SAVED.IDENTITY_CONFLICT");
    }
    return { status: "review", code: failure.code };
  }

  /** A claimed success: the task is re-derived from re-verified evidence. */
  private async claimed(
    source: Exclude<SavedEvidenceSource, { kind: "file-image" }>,
    state: State,
    signal: AbortSignal,
  ): Promise<SourceResolution> {
    try {
      if (source.kind !== "ocr-image") {
        if (state.status === "not_matched") {
          throw labelFailure("SAVED.RECEIPT_INVALID");
        }
        const task =
          source.kind === "page"
            ? await this.tasks.page(source, signal)
            : await this.tasks.pdf(source, signal);
        return { status: "resolved", source: task };
      }
      return await this.claimedImage(source, state, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (errorCodeOf(error) === "SAVED.RECEIPT_INVALID") {
        throw error;
      }
      return { status: "review", code: "SAVED.PREPARATION_UNVERIFIED" };
    }
  }

  private async claimedImage(
    source: Of<"ocr-image">,
    state: State,
    signal: AbortSignal,
  ): Promise<SourceResolution> {
    const resolved = await this.tasks.image(source, signal);
    const matched = resolved.task.input.selection.status === "matched";
    const contradicts = matched ? state.status === "not_matched" : state.status === "registered";
    if (contradicts) {
      throw labelFailure("SAVED.RECEIPT_INVALID");
    }
    return matched ? { status: "resolved", source: resolved } : { status: "not_matched" };
  }

  private async review(reviewId: string): Promise<ReviewRecord> {
    const raw = await this.deps.reviews.read(reviewId);
    if (!raw) {
      throw labelFailure("SAVED.REVIEW_UNVERIFIED");
    }
    return ReviewRecordSchema.parse(raw);
  }
}

function ownerOf(source: Exclude<SavedEvidenceSource, { kind: "file-image" }>) {
  if (source.kind === "pdf-text") {
    return observationIdentity(source.plan.extraction);
  }
  return source.kind === "page"
    ? observationIdentity(source.plan.page)
    : observationIdentity(source.task);
}

/** A download or image-preparation Review of exactly this image's plan. */
function assertPreparationReview(
  review: ReviewRecord,
  at: { source: Of<"file-image">; reviewId: string },
): void {
  const { plan } = at.source;
  const { failure, candidate } = review;
  const own = [
    review.reviewId === at.reviewId,
    failure.operationId === plan.acquire.operationId,
    failure.inputFingerprint === plan.acquire.inputFingerprint,
    isDeepStrictEqual(review.observation, observationIdentity(plan.acquire)),
  ].every(Boolean);
  const planned = failure.stage !== "image.ocr-input" || candidatePlanIs(candidate?.value, plan);
  if (!own || !planned) {
    throw labelFailure("SAVED.IDENTITY_CONFLICT");
  }
}

/** A Review candidate that records exactly this plan. */
function candidatePlanIs(value: unknown, plan: Of<"file-image">["plan"]): boolean {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  return !!record && isDeepStrictEqual((record as { plan?: unknown }).plan, plan);
}
