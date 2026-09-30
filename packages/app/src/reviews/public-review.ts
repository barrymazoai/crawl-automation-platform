import { reviewDigest } from "@crawl-automation/processing";
import type { ReviewRecord } from "@crawl-automation/v3-contracts";

/**
 * What `reviews.list` and `reviews.get` show of a Review: an explicit allowlist. Raw errors, candidate bytes and
 * inspection inputs appear only as hashes; the full record is returned only by `reviews.evidence` (owner decision
 * 2026-09-29).
 */
export function publicReview(record: ReviewRecord, registeredAt: string) {
  return {
    reviewId: record.reviewId,
    occurredAt: record.occurredAt,
    registeredAt,
    failure: record.failure,
    observation: record.observation,
    recordHash: reviewDigest(record),
    inspectionKind: record.inspection.kind,
    rawError: { retained: true as const, sha256: reviewDigest(record.rawError) },
    candidate:
      record.candidate === null
        ? null
        : { retained: true as const, sha256: reviewDigest(record.candidate) },
  };
}

export type PublicReview = ReturnType<typeof publicReview>;
