import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import { digest, parseRecord } from "./codec.js";
import { ReviewError, type PrivateReviewReader } from "./ports.js";
/** Independent, read-only recovery after an ambiguous append. Absence is not permission to recompute. */
export async function inspectRegistration(reader: PrivateReviewReader, expected: ReviewRecord) {
    const record = parseRecord(expected), recordHash = digest(record);
    const stored = await reader.read(record.reviewId);
    if (stored && digest(stored) !== recordHash)
        throw new ReviewError("REVIEW.CONFLICT");
    return { reviewId: record.reviewId, recordHash, registered: stored !== null, mutatesState: false as const };
}
