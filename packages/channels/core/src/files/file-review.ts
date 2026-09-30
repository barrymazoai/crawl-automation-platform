import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  errorCodeOf,
  recordRecovery,
  type LocalCopies,
  type ObjectStore,
} from "@crawl-automation/platform";
import {
  ReviewRecordSchema,
  observationIdentity,
  type FileAcquireInput,
  type FileAcquireOutcome,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import { fileErrors } from "./file-errors.js";
import { fileHash } from "./file-policy.js";

export interface FileEvidenceStores {
  local: ObjectStore;
  remote: ObjectStore;
  copies: LocalCopies;
  reviews: {
    read(id: string): Promise<ReviewRecord | null>;
    append(record: ReviewRecord): Promise<unknown>;
  };
}
interface FileFailure {
  input: FileAcquireInput;
  stage: "file.acquire" | "image.ocr-input";
  error: unknown;
  candidate?: unknown;
}

function fileReview(failure: FileFailure): ReviewRecord {
  const { input, stage, error, candidate } = failure;
  const rawCode = errorCodeOf(error) ?? "";
  const allowed = /^(ACQUIRE|SOURCE|ARTIFACT|INPUT|RUNTIME|IMAGE)\.[A-Z_]+$/;
  const code = allowed.test(rawCode) ? rawCode : fileErrors.code("ACQUIRE.UNRESOLVED");
  const reviewId = `acquire-${randomUUID()}`;
  const key = `acquisition-reviews/${reviewId}.json`;
  return ReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId,
    occurredAt: new Date().toISOString(),
    failure: {
      schemaVersion: 1,
      requestId: input.requestId,
      observationId: input.observationId,
      operationId: input.operationId,
      inputFingerprint: input.inputFingerprint,
      stage,
      category: "ARTIFACT",
      code,
      executionFact: "unknown",
      evidenceKey: key,
      blockedBy: null,
      automaticRetry: false,
    },
    observation: observationIdentity(input),
    rawError: { name: "AcquisitionFailure", message: code, stack: null, details: { input } },
    candidate: candidate ? { schema: "acquisition-evidence/1", value: candidate } : null,
    inspection: { kind: "none" },
  });
}

/** Same persisted Review shape; private source URLs, credentials and transport errors stay out of it. */
export async function recordFileReview(
  stores: FileEvidenceStores,
  failure: FileFailure,
): Promise<Extract<FileAcquireOutcome, { status: "review" }>> {
  const review = fileReview(failure);
  const key = `acquisition-reviews/${review.reviewId}.json`;
  const bytes = Buffer.from(JSON.stringify(review));
  const signal = AbortSignal.timeout(10000);
  await stores.local.create(key, bytes, "application/json", signal);
  const saved = await stores.local.read(key, 2 * 1024 * 1024, signal);
  if (!saved || fileHash(saved) !== fileHash(bytes)) {
    throw fileErrors.create("ACQUIRE.REVIEW_UNVERIFIED");
  }
  try {
    await stores.reviews.append(review);
  } catch (error) {
    recordRecovery(error, { operation: "file.review-append", reviewId: review.reviewId });
  }
  const confirmed = await stores.reviews.read(review.reviewId);
  if (!confirmed || !isDeepStrictEqual(ReviewRecordSchema.parse(confirmed), review)) {
    throw fileErrors.create("ACQUIRE.REVIEW_UNVERIFIED");
  }
  return {
    status: "review",
    operationId: failure.input.operationId,
    reviewId: review.reviewId,
    evidenceKey: key,
    code: review.failure.code,
    automaticRetry: false,
  };
}
