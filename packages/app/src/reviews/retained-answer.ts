import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import { isRetainedVisionReview } from "@crawl-automation/processing";
import { appErrors } from "../errors.js";
import type { ReviewStore } from "./review-ports.js";

export type RecheckStatus = "passes" | "fails" | "not_applicable" | "unavailable";

export interface RecheckResult {
  reviewId: string;
  operationId: string;
  recordedCode: string;
  status: RecheckStatus;
  code: string | null;
  reason: string | null;
}

export type RecheckOutcome = Pick<RecheckResult, "status" | "code" | "reason">;

/** Both answer kinds report the original Review identity with the same public shape. */
export function recheckResult(review: ReviewRecord, outcome: RecheckOutcome): RecheckResult {
  return {
    reviewId: review.reviewId,
    operationId: review.failure.operationId,
    recordedCode: review.failure.code,
    ...outcome,
  };
}

/** The same Review routing is used by the read-only check and manual recovery. */
export function retainedReviewKind(review: ReviewRecord): "text" | "vision" | null {
  if (isRetainedVisionReview(review)) {
    return "vision";
  }
  return review.failure.stage === "codex.text" ? "text" : null;
}

export async function readReviewRecord(reviews: Pick<ReviewStore, "read">, reviewId: string) {
  const review = await reviews.read(reviewId);
  if (!review) {
    throw appErrors.create("REVIEW.NOT_FOUND", { details: { reviewId } });
  }
  return review;
}
