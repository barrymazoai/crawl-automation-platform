import { createHash } from "node:crypto";
import { ReviewRecordSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { ReviewError } from "./ports.js";
export const MAX_REVIEW_BYTES = 2 * 1024 * 1024;
// JSON-only, depth/size bounded, deterministic across PostgreSQL jsonb key ordering.
// Reject lossy JSON (undefined, non-finite numbers, class instances), never truncate it.
export function canonical(value: unknown, depth = 0): string {
    if (depth > 48)
        throw new ReviewError("REVIEW.INVALID_RECORD");
    if (value === null || typeof value === "boolean" || typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value))
        return JSON.stringify(value);
    if (Array.isArray(value)) {
        const items = Array.from(value, item => canonical(item, depth + 1));
        return `[${items.join(",")}]`;
    }
    if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
    }
    throw new ReviewError("REVIEW.INVALID_RECORD");
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export function parseRecord(raw: unknown): ReviewRecord {
    try {
        if (Buffer.byteLength(canonical(raw)) > MAX_REVIEW_BYTES)
            throw new ReviewError("REVIEW.TOO_LARGE");
        return ReviewRecordSchema.parse(raw);
    }
    catch (error) {
        if (error instanceof ReviewError)
            throw error;
        throw new ReviewError("REVIEW.INVALID_RECORD");
    }
}
// Explicit allowlist: neither raw errors, candidate bytes, nor inspection inputs enter HTTP/logs.
export function publicRecord(record: ReviewRecord, registeredAt: string) {
    return { reviewId: record.reviewId, occurredAt: record.occurredAt, registeredAt,
        failure: record.failure, observation: record.observation, recordHash: digest(record),
        inspectionKind: record.inspection.kind,
        rawError: { retained: true as const, sha256: digest(record.rawError) },
        candidate: record.candidate === null ? null : { retained: true as const, sha256: digest(record.candidate) },
    };
}
