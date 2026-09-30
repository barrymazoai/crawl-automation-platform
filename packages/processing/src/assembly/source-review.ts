import { isDeepStrictEqual } from "node:util";
import {
  ReviewRecordSchema,
  type LabelProductJoin,
  type ReviewRecord,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import { assemblyFailure } from "./assembly-errors.js";
import type { MergeFailure } from "./merge-state.js";
import { textReviewHasFormula } from "./source-without-label.js";

type Source = LabelProductJoin["manifest"]["sources"][number];

interface ReviewReader {
  reviews: { read(reviewId: string): Promise<ReviewRecord | null> };
  visionFingerprint: (task: VisionTask) => string;
}

/** A source's Review, verified to be exactly its own model step's, as a merge failure. */
export async function sourceReviewFailure(
  deps: ReviewReader,
  source: Source,
  at: { input: LabelProductJoin; reviewId: string },
): Promise<MergeFailure> {
  const raw = await deps.reviews.read(at.reviewId);
  if (!raw) {
    throw assemblyFailure("LABEL_PRODUCT.REVIEW_UNVERIFIED");
  }
  const review = ReviewRecordSchema.parse(raw);
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
  const hasFormula = text ? textReviewHasFormula(review) : undefined;
  return {
    id: source.id,
    code: failure.code,
    verifiedExecuted: failure.executionFact === "executed",
    ...(hasFormula === undefined ? {} : { hasFormula }),
  };
}
