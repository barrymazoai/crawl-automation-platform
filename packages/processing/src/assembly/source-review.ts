import { isDeepStrictEqual } from "node:util";
import {
  ReviewRecordSchema,
  LabelImageCandidateSchema,
  type LabelProductJoin,
  type ReviewRecord,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import { assemblyFailure } from "./assembly-errors.js";
import type { MergeFailure } from "./merge-state.js";
import { textReviewHasFormula, textReviewIsPartial } from "./source-without-label.js";

type Source = LabelProductJoin["manifest"]["sources"][number];

interface ReviewReader {
  reviews: { read(reviewId: string): Promise<ReviewRecord | null> };
  visionFingerprint: (task: VisionTask) => string;
}

export type ReviewedImageReader = (
  at: { task: VisionTask; review: ReviewRecord },
  signal: AbortSignal,
) => Promise<Pick<NonNullable<MergeFailure["reviewed"]>, "record" | "candidate">>;

/** A source's Review, verified to be exactly its own model step's, as a merge failure. */
export async function sourceReviewFailure(
  deps: ReviewReader,
  source: Source,
  at: {
    input: LabelProductJoin;
    reviewId: string;
    readImage?: ReviewedImageReader | undefined;
    signal?: AbortSignal;
  },
): Promise<MergeFailure> {
  const raw = await deps.reviews.read(at.reviewId);
  if (!raw) {
    throw assemblyFailure("LABEL_PRODUCT.REVIEW_UNVERIFIED");
  }
  const review = ReviewRecordSchema.parse(raw);
  assertOwnReview(deps, source, { input: at.input, reviewId: at.reviewId, review });
  return reviewFailure(source, review, at);
}

function assertOwnReview(
  deps: ReviewReader,
  source: Source,
  at: { input: LabelProductJoin; reviewId: string; review: ReviewRecord },
) {
  const { review } = at;
  const { failure } = review;
  const text = source.kind === "text";
  const operationId = text ? source.task.operationId : source.task.input.operationId;
  const fingerprint = text ? source.task.inputFingerprint : deps.visionFingerprint(source.task);
  const stages = text ? ["codex.text", "text.receipt"] : ["codex.vision"];
  const own = [
    review.reviewId === at.reviewId,
    failure.operationId === operationId,
    failure.inputFingerprint === fingerprint,
    isDeepStrictEqual(review.observation, at.input.manifest.observation),
    stages.includes(failure.stage),
  ].every(Boolean);
  if (!own) {
    throw assemblyFailure("LABEL_PRODUCT.IDENTITY_CONFLICT");
  }
}

async function reviewFailure(
  source: Source,
  review: ReviewRecord,
  at: { readImage?: ReviewedImageReader | undefined; signal?: AbortSignal },
): Promise<MergeFailure> {
  const text = source.kind === "text";
  const { failure } = review;
  const hasFormula = text ? textReviewHasFormula(review) : undefined;
  const image = reviewedImage(source, review);
  const reviewed = image?.success ? await retainedImage(source, review, at) : undefined;
  return {
    id: source.id,
    code: failure.code,
    evidenceKey: failure.evidenceKey,
    verifiedExecuted: failure.executionFact === "executed",
    ...(hasFormula === undefined ? {} : { hasFormula }),
    ...(image?.success ? { candidate: image.data } : {}),
    ...(reviewed ? { reviewed } : {}),
    ...(text && textReviewIsPartial(review) ? { incompleteText: true } : {}),
  };
}

async function retainedImage(
  source: Source,
  review: ReviewRecord,
  at: { readImage?: ReviewedImageReader | undefined; signal?: AbortSignal },
) {
  if (
    source.kind !== "image" ||
    review.failure.executionFact !== "executed" ||
    !at.readImage ||
    !at.signal
  ) {
    return undefined;
  }
  return {
    id: source.id,
    kind: "image" as const,
    ...(await at.readImage({ task: source.task, review }, at.signal)),
  };
}

/** Missing retained response references or invalid answers cannot excuse an image failure. */
function reviewedImage(source: Source, review: ReviewRecord) {
  if (
    source.kind !== "image" ||
    !review.failure.evidenceKey ||
    review.candidate?.schema !== "label-extraction/1"
  ) {
    return null;
  }
  return LabelImageCandidateSchema.safeParse(review.candidate.value);
}
