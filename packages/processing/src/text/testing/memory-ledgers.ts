import type { ReviewRecord, TextRecord } from "@crawl-automation/v3-contracts";
import { parseReviewRecord, reviewDigest } from "../../step/review-record.js";
import type { TextResultRegistry } from "../ports.js";

/** An in-memory result ledger for tests, with a lost-acknowledgement and an unavailable switch. */
export class MemoryTextRegistry implements TextResultRegistry {
  readonly data = new Map<string, TextRecord>();
  loseAcknowledgement = false;
  unavailable = false;

  async read(operationId: string): Promise<TextRecord | null> {
    return this.data.get(operationId) ?? null;
  }

  async register(record: TextRecord): Promise<void> {
    if (this.unavailable) {
      throw new Error("ledger unavailable");
    }
    this.data.set(record.input.operationId, record);
    if (this.loseAcknowledgement) {
      throw new Error("acknowledgement lost");
    }
  }
}

/** An in-memory Review ledger for tests. */
export class MemoryReviews {
  readonly records = new Map<string, ReviewRecord>();
  failAppends = false;

  async read(reviewId: string): Promise<ReviewRecord | null> {
    return this.records.get(reviewId) ?? null;
  }

  async append(raw: ReviewRecord) {
    if (this.failAppends) {
      throw new Error("Review ledger unavailable");
    }
    const record = parseReviewRecord(raw);
    this.records.set(record.reviewId, record);
    return {
      registered: true as const,
      reviewId: record.reviewId,
      recordHash: reviewDigest(record),
    };
  }
}
