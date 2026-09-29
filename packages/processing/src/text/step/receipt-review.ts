import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ObjectStore } from "@crawl-automation/platform";
import {
  ReviewRecordSchema,
  textObservation,
  type ReviewRecord,
  type TextInput,
} from "@crawl-automation/v3-contracts";
import { isAppError } from "@crawl-automation/platform";
import { receiptFailure } from "./receipt-errors.js";
import { textReviewFailure } from "./review-failure.js";
import { textLimits } from "../limits.js";

export interface ReviewLedger {
  read(id: string): Promise<ReviewRecord | null>;
  append(record: ReviewRecord): Promise<unknown>;
}

const KEPT_CODES = new Set([
  "TEXT_RECEIPT.IDENTITY_CONFLICT",
  "TEXT_RECEIPT.REVIEW_UNVERIFIED",
  "TEXT_RECEIPT.TEXT_UNCONFIRMED",
]);
const MAX_REVIEW_BYTES = 2 * 1024 * 1024;

/** The receipt's own Review: kept locally first, then appended once and read back. */
export async function recordReceiptFailure(failure: ReceiptFailure): Promise<ReviewRecord> {
  const reviewId = `text-receipt-${randomUUID()}`;
  const record = receiptReview(failure, reviewId);
  await keepLocally(failure.local, record.failure.evidenceKey, record);
  try {
    await failure.reviews.append(record);
  } catch {
    // Read back the exact ID; never append twice.
  }
  const confirmed = await failure.reviews.read(reviewId);
  if (!confirmed || !isDeepStrictEqual(ReviewRecordSchema.parse(confirmed), record)) {
    throw receiptFailure("TEXT_RECEIPT.REVIEW_UNVERIFIED");
  }
  return record;
}

interface ReceiptFailure {
  input: TextInput;
  outcome: unknown;
  error: unknown;
  local: ObjectStore;
  reviews: ReviewLedger;
}

/** The receipt's own codes are kept; any other failure is EVIDENCE_UNVERIFIED. */
function receiptCode(error: unknown): string {
  return isAppError(error) && KEPT_CODES.has(error.code)
    ? error.code
    : "TEXT_RECEIPT.EVIDENCE_UNVERIFIED";
}

function receiptReview(failure: ReceiptFailure, reviewId: string): ReviewRecord {
  const { input } = failure;
  const code = receiptCode(failure.error);
  return ReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId,
    occurredAt: new Date().toISOString(),
    failure: textReviewFailure(input, {
      stage: "text.receipt",
      code,
      executionFact: "unknown",
      evidenceKey: `text-receipt-reviews/${reviewId}.json`,
      blockedBy: null,
    }),
    observation: textObservation(input),
    rawError: {
      name: "TextReceiptFailure",
      message: code,
      stack: null,
      details: { input, outcome: failure.outcome },
    },
    candidate: null,
    inspection: { kind: "none" },
  });
}

async function keepLocally(local: ObjectStore, key: string, record: ReviewRecord): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(record));
  const retention = AbortSignal.timeout(textLimits.retentionMs);
  await local.create(key, bytes, "application/json", retention);
  const saved = await local.read(key, MAX_REVIEW_BYTES, retention);
  if (!saved || !Buffer.from(saved).equals(bytes)) {
    throw receiptFailure("TEXT_RECEIPT.LOCAL_UNVERIFIED");
  }
}
