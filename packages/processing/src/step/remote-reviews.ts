import type { ObjectStore } from "@crawl-automation/platform";
import { ExecutionIdSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { reviewErrors } from "./review-errors.js";
import type { ReviewReader, ReviewReceipt, ReviewWriter } from "./review-ledger.js";
import { MAX_REVIEW_BYTES, parseReviewRecord, reviewDigest } from "./review-record.js";

const DEFAULT_PREFIX = "v3/ocr-reviews";
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Reviews kept as immutable objects by a worker without ledger access. The receipt step reads them back, checks
 * their identity, and registers them in the ledger.
 */
export class RemoteReviews implements ReviewReader, ReviewWriter {
  constructor(
    private readonly store: ObjectStore,
    private readonly prefix = DEFAULT_PREFIX,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  key(reviewId: string): string {
    return `${this.prefix}/${ExecutionIdSchema.parse(reviewId)}.json`;
  }

  async read(reviewId: string): Promise<ReviewRecord | null> {
    const bytes = await this.fetch(reviewId);
    if (!bytes) {
      return null;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const record = parseReviewRecord(JSON.parse(text));
      if (record.reviewId === reviewId) {
        return record;
      }
    } catch (error) {
      throw reviewErrors.create("REVIEW.INTEGRITY", { details: { reviewId }, cause: error });
    }
    throw reviewErrors.create("REVIEW.INTEGRITY", { details: { reviewId, reason: "other ID" } });
  }

  async append(raw: ReviewRecord): Promise<ReviewReceipt> {
    const record = parseReviewRecord(raw);
    const hash = reviewDigest(record);
    const bytes = Buffer.from(JSON.stringify(record));
    const signal = AbortSignal.timeout(this.timeoutMs);
    // An unknown write is settled by the read-back below, never by assuming success.
    await this.store.create(this.key(record.reviewId), bytes, "application/json", signal).then(
      () => undefined,
      () => undefined,
    );
    const stored = await this.read(record.reviewId);
    if (!stored) {
      throw reviewErrors.create("REVIEW.REGISTRATION_UNKNOWN", {
        details: { reviewId: record.reviewId },
      });
    }
    if (reviewDigest(stored) !== hash) {
      throw reviewErrors.create("REVIEW.CONFLICT", { details: { reviewId: record.reviewId } });
    }
    return { reviewId: record.reviewId, recordHash: hash, registered: true };
  }

  private async fetch(reviewId: string): Promise<Uint8Array | null> {
    try {
      const signal = AbortSignal.timeout(this.timeoutMs);
      return await this.store.read(this.key(reviewId), MAX_REVIEW_BYTES, signal);
    } catch (error) {
      throw reviewErrors.create("REVIEW.UNAVAILABLE", { details: { reviewId }, cause: error });
    }
  }
}
