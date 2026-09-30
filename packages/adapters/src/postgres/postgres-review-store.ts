import type { ReviewLedger, ReviewStore } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import type { ReviewReceipt } from "@crawl-automation/processing";
import type { ReviewListQuery, ReviewRecord } from "@crawl-automation/v3-contracts";
import { PostgresReviewRecords } from "./postgres-review-records.js";

/** Reviews in `review_record`, read only; `read` returns the full record (evidence API). */
export class PostgresReviewStore implements ReviewStore {
  private readonly reviews: PostgresReviewRecords;

  constructor(database: Database) {
    this.reviews = new PostgresReviewRecords(database);
  }

  list(query: ReviewListQuery): Promise<unknown> {
    return this.reviews.list(query);
  }

  summary(): Promise<unknown> {
    return this.reviews.summary();
  }

  find(reviewId: string): Promise<unknown> {
    return this.reviews.get(reviewId);
  }

  /** The full stored record, checked; for the read-only Review evidence procedures. */
  read(reviewId: string): Promise<ReviewRecord | null> {
    return this.reviews.read(reviewId);
  }
}

/** Writes Reviews into `review_record`; each record is checked before it is stored. */
export class PostgresReviewLedger implements ReviewLedger {
  private readonly reviews: PostgresReviewRecords;

  constructor(database: Database) {
    this.reviews = new PostgresReviewRecords(database);
  }

  read(reviewId: string): Promise<ReviewRecord | null> {
    return this.reviews.read(reviewId);
  }

  /** The ledger's receipt (ID, record hash), which the processing steps read back. */
  append(record: ReviewRecord): Promise<ReviewReceipt> {
    return this.reviews.append(record);
  }
}
