import type { ReviewListQuery } from "@crawl-automation/v3-contracts";
import { appErrors } from "../errors.js";

export interface ReviewStore {
  list(query: ReviewListQuery): Promise<unknown>;
  find(reviewId: string): Promise<unknown>;
  summary(): Promise<unknown>;
  inspect(reviewId: string): Promise<unknown>;
}

/** Products that could not be finished, each with its reason. A Review is never retried automatically. */
export class ReviewService {
  constructor(private readonly deps: { reviews: ReviewStore }) {}

  list(query: ReviewListQuery): Promise<unknown> {
    return this.deps.reviews.list(query);
  }

  summary(): Promise<unknown> {
    return this.deps.reviews.summary();
  }

  async get(reviewId: string): Promise<unknown> {
    const review = await this.deps.reviews.find(reviewId);
    if (review === null) {
      throw appErrors.create("REVIEW.NOT_FOUND", { details: { reviewId } });
    }
    return review;
  }

  /** The Review with its retained evidence checked. */
  inspect(reviewId: string): Promise<unknown> {
    return this.deps.reviews.inspect(reviewId);
  }
}
