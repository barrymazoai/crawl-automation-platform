import { createHash } from "node:crypto";
import { ReviewRecordSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { reviewErrors } from "./review-errors.js";

/** The largest Review record the ledger keeps. */
export const MAX_REVIEW_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 48;

function canonicalObject(value: object, depth: number): string {
  const entries = Object.keys(value)
    .sort()
    .map((key) => {
      const field = (value as Record<string, unknown>)[key];
      return `${JSON.stringify(key)}:${canonicalJson(field, depth + 1)}`;
    });
  return `{${entries.join(",")}}`;
}

function isScalar(value: unknown): boolean {
  const finiteNumber = typeof value === "number" && Number.isFinite(value);
  return value === null || typeof value === "boolean" || typeof value === "string" || finiteNumber;
}

/**
 * JSON text with sorted keys, so a record hashes the same after PostgreSQL's jsonb reorders it. Lossy values
 * (undefined, non-finite numbers, class instances) are refused, never dropped.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) {
    throw reviewErrors.create("REVIEW.INVALID_RECORD", { details: { reason: "too deep" } });
  }
  if (isScalar(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, (item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return canonicalObject(value, depth);
  }
  throw reviewErrors.create("REVIEW.INVALID_RECORD", { details: { reason: "not plain JSON" } });
}

/** The record hash the ledger stores beside each Review. */
export function reviewDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Checks size and shape; a record that fails is refused whole, never truncated. */
export function parseReviewRecord(raw: unknown): ReviewRecord {
  if (Buffer.byteLength(canonicalJson(raw)) > MAX_REVIEW_BYTES) {
    throw reviewErrors.create("REVIEW.TOO_LARGE");
  }
  const parsed = ReviewRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw reviewErrors.create("REVIEW.INVALID_RECORD", { cause: parsed.error });
  }
  return parsed.data;
}
