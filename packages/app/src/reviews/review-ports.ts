import type { ReviewListQuery, ReviewRecord } from "@crawl-automation/v3-contracts";

export interface ReviewStore {
  list(query: ReviewListQuery): Promise<unknown>;
  find(reviewId: string): Promise<unknown>;
  /** The full stored record, or null. */
  read(reviewId: string): Promise<ReviewRecord | null>;
  summary(): Promise<unknown>;
}
