import { isDeepStrictEqual } from "node:util";
import type { AppError, ObjectStore } from "@crawl-automation/platform";
import { ReviewRecordSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";

export interface ReviewLedger {
  read(id: string): Promise<ReviewRecord | null>;
  append(record: ReviewRecord): Promise<unknown>;
}

const MAX_REVIEW_BYTES = 2 * 1024 * 1024;
const RETENTION_MS = 10_000;

/**
 * A Review kept in the local store first (so it survives a lost ledger write), then appended once and read back by
 * its ID. Used by the steps that write their own Review outside the processing step template.
 */
export async function keepAndRecordReview(
  review: ReviewRecord,
  place: { local: ObjectStore; key: string; reviews: ReviewLedger },
  failures: { localUnverified: () => AppError; reviewUnverified: () => AppError },
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(review));
  const retention = AbortSignal.timeout(RETENTION_MS);
  await place.local.create(place.key, bytes, "application/json", retention);
  const saved = await place.local.read(place.key, MAX_REVIEW_BYTES, retention);
  if (!saved || !Buffer.from(saved).equals(bytes)) {
    throw failures.localUnverified();
  }
  await appendConfirmed(place.reviews, review, failures.reviewUnverified);
}

/** Appends once and reads the exact ID back; the ledger may reorder JSON keys, so values are compared. */
export async function appendConfirmed(
  reviews: ReviewLedger,
  review: ReviewRecord,
  unverified: () => AppError,
): Promise<ReviewRecord> {
  try {
    await reviews.append(review);
  } catch {
    // Read back the exact ID; never append twice.
  }
  const confirmed = await reviews.read(review.reviewId);
  if (!confirmed || !isDeepStrictEqual(ReviewRecordSchema.parse(confirmed), review)) {
    throw unverified();
  }
  return confirmed;
}
