import { ExecutionIdSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { digest, parseRecord } from "./codec.js";
import { ReviewError, type PrivateReviewReader, type ReviewWriter } from "./ports.js";

/** Structural subset of the artifacts ObjectStore; kept local so this package stays ledger-only in dependencies. */
export interface ReviewObjectStore {
    read(key: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null>;
    create(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal): Promise<"created" | "exists">;
}
const LIMIT = 2 * 1024 * 1024;
/** Cloud mode: a worker without ledger access retains Review records as immutable objects.
 * The Mini receipt step reads them back, verifies identity, and registers them in the ledger. */
export class RemoteReviews implements PrivateReviewReader, ReviewWriter {
    constructor(private readonly store: ReviewObjectStore, private readonly prefix = "v3/ocr-reviews", private readonly timeoutMs = 20000) { }
    key(reviewId: string) { return `${this.prefix}/${ExecutionIdSchema.parse(reviewId)}.json`; }
    async read(reviewId: string): Promise<ReviewRecord | null> {
        let bytes: Uint8Array | null;
        try {
            bytes = await this.store.read(this.key(reviewId), LIMIT, AbortSignal.timeout(this.timeoutMs));
        }
        catch {
            throw new ReviewError("REVIEW.UNAVAILABLE");
        }
        if (!bytes)
            return null;
        try {
            const record = parseRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
            if (record.reviewId !== reviewId)
                throw Error();
            return record;
        }
        catch {
            throw new ReviewError("REVIEW.INTEGRITY");
        }
    }
    async append(raw: ReviewRecord) {
        const record = parseRecord(raw), hash = digest(record), bytes = Buffer.from(JSON.stringify(record));
        try {
            await this.store.create(this.key(record.reviewId), bytes, "application/json", AbortSignal.timeout(this.timeoutMs));
        }
        catch { /* An unknown PUT is settled by the read-back below, never by assuming success. */ }
        const stored = await this.read(record.reviewId);
        if (!stored)
            throw new ReviewError("REVIEW.REGISTRATION_UNKNOWN");
        if (digest(stored) !== hash)
            throw new ReviewError("REVIEW.CONFLICT");
        return { reviewId: record.reviewId, recordHash: hash, registered: true as const };
    }
}
/** Ledger first; retained remote Reviews only answer reads for records the receipt step has not registered yet. */
export class ReviewsWithRemoteFallback implements PrivateReviewReader {
    constructor(private readonly ledger: PrivateReviewReader, private readonly remote: PrivateReviewReader) { }
    async read(reviewId: string): Promise<ReviewRecord | null> {
        return (await this.ledger.read(reviewId)) ?? this.remote.read(reviewId);
    }
}
