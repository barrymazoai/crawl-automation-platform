import { publicReview, type PublicReview } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import {
  parseReviewRecord,
  reviewDigest,
  reviewErrors,
  type ReviewReceipt,
} from "@crawl-automation/processing";
import {
  ExecutionIdSchema,
  ReviewListQuerySchema,
  type ReviewListQuery,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import {
  INSERT_REVIEW,
  listReviewsQuery,
  SELECT_REVIEW,
  SUMMARY_REVIEWS,
  type ReviewRow,
} from "./review-record-queries.js";

/** The Review ledger in `review_record`: each record is checked against its ID and record hash on every read. */
export class PostgresReviewRecords {
  constructor(private readonly database: Database) {}

  async read(reviewId: string): Promise<ReviewRecord | null> {
    const row = await this.row(reviewId);
    return row ? this.checked(row) : null;
  }

  async get(reviewId: string): Promise<PublicReview | null> {
    const row = await this.row(reviewId);
    return row ? publicReview(this.checked(row), row.registered_at.toISOString()) : null;
  }

  /** Stores once and reads back; even a committed INSERT whose answer was lost is not acknowledged. */
  async append(raw: ReviewRecord): Promise<ReviewReceipt> {
    const record = parseReviewRecord(raw);
    const recordHash = reviewDigest(record);
    const details = { reviewId: record.reviewId };
    try {
      await this.database.query(INSERT_REVIEW, [
        record.reviewId,
        recordHash,
        JSON.stringify(record),
      ]);
      const stored = await this.read(record.reviewId);
      if (!stored) {
        throw reviewErrors.create("REVIEW.REGISTRATION_UNKNOWN", { details });
      }
      if (reviewDigest(stored) !== recordHash) {
        throw reviewErrors.create("REVIEW.CONFLICT", { details });
      }
      return { reviewId: record.reviewId, recordHash, registered: true };
    } catch (error) {
      if (reviewErrors.is(error, "REVIEW.CONFLICT")) {
        throw error;
      }
      throw reviewErrors.create("REVIEW.REGISTRATION_UNKNOWN", { details, cause: error });
    }
  }

  async list(raw: ReviewListQuery): Promise<{ items: PublicReview[]; nextCursor: string | null }> {
    const query = ReviewListQuerySchema.parse(raw);
    const { sql, params } = listReviewsQuery(query);
    const rows = await this.query<ReviewRow>(sql, params);
    const items = rows
      .slice(0, query.limit)
      .map((row) => publicReview(this.checked(row), row.registered_at.toISOString()));
    const nextCursor = rows.length > query.limit ? (items.at(-1)?.reviewId ?? null) : null;
    return { items, nextCursor };
  }

  async summary(): Promise<{ total: number; categories: { category: string; count: number }[] }> {
    const rows = await this.query<{ category: string; count: string }>(SUMMARY_REVIEWS, []);
    const categories = rows.map((row) => ({ category: row.category, count: Number(row.count) }));
    const total = categories.reduce((sum, row) => sum + row.count, 0);
    return { total, categories };
  }

  private async row(reviewId: string): Promise<ReviewRow | null> {
    ExecutionIdSchema.parse(reviewId);
    const rows = await this.query<ReviewRow>(SELECT_REVIEW, [reviewId]);
    return rows[0] ?? null;
  }

  private async query<Row extends object>(sql: string, params: unknown[]): Promise<Row[]> {
    try {
      return await this.database.query<Row>(sql, params);
    } catch (error) {
      throw reviewErrors.create("REVIEW.UNAVAILABLE", { cause: error });
    }
  }

  private checked(row: ReviewRow): ReviewRecord {
    try {
      const record = parseReviewRecord(row.record);
      if (record.reviewId === row.review_id && reviewDigest(record) === row.record_hash) {
        return record;
      }
    } catch (error) {
      throw reviewErrors.create("REVIEW.INTEGRITY", {
        details: { reviewId: row.review_id },
        cause: error,
      });
    }
    throw reviewErrors.create("REVIEW.INTEGRITY", { details: { reviewId: row.review_id } });
  }
}
