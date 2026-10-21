import { sha256 } from "@crawl-automation/platform";
import {
  recheckDigest,
  recheckErrors,
  retainedVisionReviewAnswer,
} from "@crawl-automation/processing";
import { LabelImageCandidateSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import type { RetainedVisionAnswer } from "@crawl-automation/processing";
import type { RecoveryItem } from "./recovery-model.js";
import type { ReviewRecoveryDeps } from "./recovery-ports.js";

/** A vision Review's current candidate and proof of its original response. */
export async function evaluateVisionRecovery(
  review: ReviewRecord,
  deps: ReviewRecoveryDeps,
  signal: AbortSignal,
) {
  const answer = await retainedVisionReviewAnswer(review, deps.objects, signal);
  const candidateSummary = summarizeVisionCandidate(answer);
  const base = {
    reviewId: review.reviewId,
    originalReviewHash: recheckDigest(review),
    digest: recheckDigest([review, sha256(answer.bytes), answer.decoded]),
    candidateSummary,
  };
  if (answer.decoded.status === "review") {
    return { item: reviewedVisionItem(base, answer.decoded.code) };
  }
  if (!deps.ledger.supportsVision || !deps.vision) {
    throw recheckErrors.create("RECHECK.PUBLICATION_UNVERIFIED");
  }
  const verified = await deps.vision.evidence.verify(answer.task, { allowLocal: false }, signal);
  if (sha256(verified.bytes) !== sha256(answer.bytes)) {
    throw recheckErrors.create("RECHECK.IDENTITY_CONFLICT");
  }
  const item: RecoveryItem = {
    ...base,
    status: "recoverable",
    codes: [],
    operationId: answer.task.input.operationId,
  };
  return { item, visionTask: answer.task };
}

function reviewedVisionItem(
  base: Pick<RecoveryItem, "reviewId" | "originalReviewHash" | "digest" | "candidateSummary">,
  code: string | null,
): RecoveryItem {
  return {
    ...base,
    status: "review",
    codes: code ? [code] : ["VISION.INVALID_OUTPUT"],
    operationId: null,
  };
}

function summarizeVisionCandidate(answer: RetainedVisionAnswer) {
  const parsed = LabelImageCandidateSchema.safeParse(answer.decoded.candidate);
  if (!parsed.success) {
    return undefined;
  }
  return {
    status: answer.decoded.status,
    formulaColumns: parsed.data.formula?.columns.length ?? 0,
    formulaRows:
      parsed.data.formula?.columns.reduce((total, column) => total + column.rows.length, 0) ?? 0,
    otherIngredients: parsed.data.otherIngredients?.items.length ?? 0,
  };
}
