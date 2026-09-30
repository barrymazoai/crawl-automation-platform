import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import { reviewErrors } from "./review-errors.js";
import { parseReviewRecord, reviewDigest } from "./review-record.js";

/** What the ledger answers after storing a Review. */
export interface ReviewReceipt {
  reviewId: string;
  recordHash: string;
  registered: true;
}

/** Reads a full stored Review by its ID; private to the backend, never an HTTP answer. */
export interface ReviewReader {
  read(reviewId: string): Promise<ReviewRecord | null>;
}

/** Stores a Review once. */
export interface ReviewWriter {
  append(record: ReviewRecord): Promise<ReviewReceipt>;
}

/**
 * Read-only check after an append whose answer was lost: whether the exact Review is stored. A different Review under
 * the same ID is a conflict; absence is not permission to append again.
 */
export async function inspectRegistration(
  reader: ReviewReader,
  expected: ReviewRecord,
): Promise<{ reviewId: string; recordHash: string; registered: boolean }> {
  const record = parseReviewRecord(expected);
  const recordHash = reviewDigest(record);
  const stored = await reader.read(record.reviewId);
  if (stored && reviewDigest(stored) !== recordHash) {
    throw reviewErrors.create("REVIEW.CONFLICT", { details: { reviewId: record.reviewId } });
  }
  return { reviewId: record.reviewId, recordHash, registered: stored !== null };
}
