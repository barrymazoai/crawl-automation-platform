import type { ReviewListQuery, ReviewRecord } from "@crawl-automation/v3-contracts";
import type { publicRecord } from "./codec.js";
export class ReviewError extends Error {
    constructor(readonly code: "REVIEW.INVALID_RECORD" | "REVIEW.TOO_LARGE" | "REVIEW.CONFLICT" | "REVIEW.INTEGRITY" | "REVIEW.UNAVAILABLE" | "REVIEW.REGISTRATION_UNKNOWN" | "REVIEW.NOT_FOUND") { super(code); this.name = "ReviewError"; }
}
export type ReviewDetail = ReturnType<typeof publicRecord>;
export interface ReviewReader {
    get(reviewId: string): Promise<ReviewDetail | null>;
    list(query: ReviewListQuery): Promise<{
        items: ReviewDetail[];
        nextCursor: string | null;
    }>;
    summary(): Promise<{
        total: number;
        categories: {
            category: string;
            count: number;
        }[];
    }>;
}
/** Private backend access, deliberately distinct from the HTTP reader. */
export interface PrivateReviewReader {
    read(reviewId: string): Promise<ReviewRecord | null>;
}
export interface ReviewWriter {
    append(record: ReviewRecord): Promise<{
        reviewId: string;
        recordHash: string;
        registered: true;
    }>;
}
