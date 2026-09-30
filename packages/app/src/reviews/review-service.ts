import type { ReviewListQuery, ReviewRecord } from "@crawl-automation/v3-contracts";
import { appErrors } from "../errors.js";
import type { ReviewEvidence } from "./review-evidence.js";
import { inspectReview } from "./review-inspection.js";
import { ReviewPageSchema, type ReviewRecheckInput } from "./review-model.js";
import type { RecheckResult, RecheckStatus, TextAnswerRecheck } from "./text-recheck.js";

export interface ReviewStore {
  list(query: ReviewListQuery): Promise<unknown>;
  find(reviewId: string): Promise<unknown>;
  /** The full stored record, or null. */
  read(reviewId: string): Promise<ReviewRecord | null>;
  summary(): Promise<unknown>;
}

export interface ReviewServiceDeps {
  reviews: ReviewStore;
  /** Reading evidence from R2; absent when the API has no storage settings. */
  evidence?: { files: ReviewEvidence; recheck: TextAnswerRecheck };
}

/** How long one recheck or evidence request may read R2. */
const EVIDENCE_TIMEOUT_MS = 120_000;

/** Products that could not be finished, each with its reason. A Review is never retried automatically. */
export class ReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

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

  /** A read-only view of the Review's inspection target. */
  async inspect(reviewId: string) {
    return inspectReview(await this.record(reviewId));
  }

  /** The full Review record with its evidence files from R2. Read only. */
  async evidence(reviewId: string) {
    const { files } = this.evidenceReaders();
    const review = await this.record(reviewId);
    return { review, files: await files.files(review, AbortSignal.timeout(EVIDENCE_TIMEOUT_MS)) };
  }

  /** Whether stored model answers would pass today's decoding rules. No model call, no writes. */
  async recheck(input: ReviewRecheckInput) {
    const { recheck } = this.evidenceReaders();
    const signal = AbortSignal.timeout(EVIDENCE_TIMEOUT_MS);
    const items: RecheckResult[] = [];
    for (const reviewId of await this.selected(input)) {
      items.push(await recheck.check(await this.record(reviewId), signal));
    }
    return { items, summary: countByStatus(items) };
  }

  private async selected(input: ReviewRecheckInput): Promise<string[]> {
    if ("reviewId" in input) {
      return [input.reviewId];
    }
    const page = ReviewPageSchema.parse(
      await this.deps.reviews.list({ ...input.filter, limit: input.limit }),
    );
    return page.items.map((item) => item.reviewId);
  }

  private async record(reviewId: string): Promise<ReviewRecord> {
    const review = await this.deps.reviews.read(reviewId);
    if (review === null) {
      throw appErrors.create("REVIEW.NOT_FOUND", { details: { reviewId } });
    }
    return review;
  }

  private evidenceReaders() {
    if (!this.deps.evidence) {
      throw appErrors.create("REVIEW.EVIDENCE_NOT_CONFIGURED");
    }
    return this.deps.evidence;
  }
}

function countByStatus(items: RecheckResult[]): Record<RecheckStatus, number> {
  const counts: Record<RecheckStatus, number> = {
    passes: 0,
    fails: 0,
    not_applicable: 0,
    unavailable: 0,
  };
  for (const item of items) {
    counts[item.status] += 1;
  }
  return counts;
}
