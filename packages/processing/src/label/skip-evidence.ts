import { isDeepStrictEqual } from "node:util";
import {
  LabelImageCandidateSchema,
  ReviewRecordSchema,
  isCompleteLabelImage,
  labelImageIntegrityCodes,
  type LabelProductManifest,
  type ReviewRecord,
  type SavedEvidenceSource,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import { labelFailure } from "./label-errors.js";
import type { SourceState } from "./label-plan-model.js";
import type { LabelInspection, SelectionContext } from "./selection-model.js";

type Source = LabelProductManifest["sources"][number];
type ReviewState = Extract<SourceState, { status: "review" }>;
type At = { state: SourceState; context: SelectionContext };

const unverified = () => labelFailure("CHANNEL.LABEL_SELECTION_UNVERIFIED");
const VERDICT = /^VISION\.LABEL_[A-Z_]+$/;

/** Checks the Review behind each image the selection skips, so a skip is never taken on trust. */
export class SkipEvidence {
  constructor(
    private readonly deps: {
      inspection: LabelInspection;
      visionFingerprint: (task: VisionTask) => string;
    },
  ) {}

  /**
   * An image whose OCR ran and found no text cannot hold a label; it is skipped once its saved input and its exact
   * Review are verified, whether or not another image was selected. (2026-09-28: requiring a selection stopped 179
   * products; in a sample of 16, 10 had a readable facts panel in another image and every flagged image was a photo
   * with no label text.)
   */
  async emptyOcr(source: SavedEvidenceSource, at: At): Promise<Record<string, unknown> | null> {
    const { state, context } = at;
    const other = source.kind === "file-image" && source.id !== context.selection.selectedImageId;
    if (!other || state.status !== "review") {
      return null;
    }
    const review = await this.executedEmptyOcr(state.reviewId);
    if (!review) {
      return null;
    }
    await this.assertEmptyOcrSource(source, { review, state, context });
    return { reason: "verified_empty_ocr", code: review.failure.code, state };
  }

  /** The Review, when it records an OCR run that found no text. */
  private async executedEmptyOcr(reviewId: string): Promise<ReviewRecord | null> {
    const raw = await this.deps.inspection.review(reviewId);
    const review = raw ? ReviewRecordSchema.parse(raw) : null;
    const failure = review?.failure;
    const empty =
      failure?.stage === "ocr.file" &&
      failure.code === "OCR.EMPTY" &&
      failure.executionFact === "executed";
    return empty ? review : null;
  }

  /** The empty-OCR Review is this image's, and its saved input still resolves to exactly that Review. */
  private async assertEmptyOcrSource(
    source: SavedEvidenceSource,
    at: { review: ReviewRecord; state: ReviewState; context: SelectionContext },
  ): Promise<void> {
    const { review, state, context } = at;
    const own =
      review.reviewId === state.reviewId &&
      isDeepStrictEqual(review.observation, context.selection.input.owner);
    const reviewSource = this.deps.inspection.reviewSource;
    if (!own || !reviewSource) {
      throw unverified();
    }
    const verified = await reviewSource(source, state, context.signal);
    if (verified.status !== "review" || verified.code !== "OCR.EMPTY") {
      throw unverified();
    }
  }

  /**
   * An image other than the selected one, whose vision step ended in a Review. The state itself is the first-hand
   * fact (a usable label would be `registered`); a Review record that is there is still checked in full. A turn that
   * never produced a verdict read no label at all. (2026-09-18: 139 products lost a complete label here when the
   * record was required; 2026-09-19: 22 when a failed turn was treated as a forged skip.)
   */
  async incompleteImage(source: Source, at: At): Promise<Record<string, unknown>> {
    const { state, context } = at;
    const reviewState = state as ReviewState;
    const retained = await this.deps.inspection.review(reviewState.reviewId);
    if (!retained) {
      return { reason: "incomplete_label_review_unretained", state };
    }
    const review = ReviewRecordSchema.parse(retained);
    if (
      source.kind !== "image" ||
      !this.ownVisionReview(review, { source, state: reviewState, context })
    ) {
      throw unverified();
    }
    const { failure } = review;
    if (failure.executionFact !== "executed" || !VERDICT.test(failure.code)) {
      return { reason: "incomplete_label_no_verdict", code: failure.code, state };
    }
    const candidate = LabelImageCandidateSchema.parse(review.candidate?.value);
    if (
      isCompleteLabelImage({ kind: "image", candidate }) &&
      !labelImageIntegrityCodes(candidate).length
    ) {
      throw unverified();
    }
    return { reason: "incomplete_label", state };
  }

  /** The Review belongs to exactly this image's vision task of this observation. */
  private ownVisionReview(
    review: ReviewRecord,
    at: {
      source: Extract<Source, { kind: "image" }>;
      state: ReviewState;
      context: SelectionContext;
    },
  ): boolean {
    const { source, state, context } = at;
    const { failure } = review;
    return (
      review.reviewId === state.reviewId &&
      failure.operationId === source.task.input.operationId &&
      failure.inputFingerprint === this.deps.visionFingerprint(source.task) &&
      failure.stage === "codex.vision" &&
      isDeepStrictEqual(review.observation, context.selection.input.owner) &&
      isDeepStrictEqual(review.rawError.details, {
        task: source.task,
        evidenceKey: failure.evidenceKey,
      })
    );
  }
}
