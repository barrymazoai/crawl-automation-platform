import { appErrors, type ReviewLedger, type ReviewStore } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import type { ReviewListQuery, ReviewRecord } from "@crawl-automation/v3-contracts";
import { PostgresReviews, ReviewError, ReviewInspector } from "@crawl-automation/v3-review";

type PgQueryable = ConstructorParameters<typeof PostgresReviews>[0];

/**
 * `v3-review` expects a `pg`-style `query` that returns `{ rows }`; the platform database returns the rows.
 * This bridge exists until that package moves under the platform in the channel phase.
 */
function pgStyle(database: Database): PgQueryable {
  const query = async (sql: string, values?: unknown[]) => ({
    rows: await database.query(sql, values),
  });
  return { query } as unknown as PgQueryable;
}

/** Reviews stored by `v3-review` in `review_record`. Read-only. */
export class PostgresReviewStore implements ReviewStore {
  private readonly reviews: PostgresReviews;
  private readonly inspector: ReviewInspector;

  constructor(database: Database) {
    this.reviews = new PostgresReviews(pgStyle(database));
    this.inspector = new ReviewInspector(this.reviews);
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

  async inspect(reviewId: string): Promise<unknown> {
    try {
      return await this.inspector.inspect(reviewId);
    } catch (error) {
      if (error instanceof ReviewError && error.code === "REVIEW.NOT_FOUND") {
        throw appErrors.create("REVIEW.NOT_FOUND", { details: { reviewId }, cause: error });
      }
      throw error;
    }
  }
}

/** Writes Reviews into `review_record` through `v3-review`, which checks each record. */
export class PostgresReviewLedger implements ReviewLedger {
  private readonly reviews: PostgresReviews;

  constructor(database: Database) {
    this.reviews = new PostgresReviews(pgStyle(database));
  }

  read(reviewId: string): Promise<ReviewRecord | null> {
    return this.reviews.read(reviewId);
  }

  append(record: ReviewRecord): Promise<unknown> {
    return this.reviews.append(record);
  }
}
