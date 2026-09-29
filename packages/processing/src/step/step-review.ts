import { randomUUID } from "node:crypto";
import type { AppError } from "@crawl-automation/platform";
import { ReviewRecordSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import {
  inspectRegistration,
  type PrivateReviewReader,
  type ReviewWriter,
} from "@crawl-automation/v3-review";
import type { ExecutionFact } from "./step-failure.js";

/** The task a Review is about. */
export interface ReviewedTask {
  requestId: string;
  observationId: string;
  operationId: string;
  inputFingerprint: string;
}

export interface StepReviewParts {
  reviewId: string;
  task: ReviewedTask;
  observation: unknown;
  stage: string;
  category: "PROCESSING" | "ARTIFACT";
  code: string;
  fact: ExecutionFact;
  evidenceKey: string;
  /** The upstream operation that blocked this one, when it never ran because of it. */
  blockedBy: string | null;
  error: { name: string; details: Record<string, unknown> };
  candidate: { schema: string; value: unknown } | null;
  inspection: unknown;
}

/** A fresh Review ID: `<prefix>-<uuid>`. */
export const newReviewId = (prefix: string) => `${prefix}-${randomUUID()}`;

/** A processing step's Review: the task's identity, what went wrong, and what the service answered, if anything. */
export function buildStepReview(parts: StepReviewParts): ReviewRecord {
  const { task, code } = parts;
  return ReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId: parts.reviewId,
    occurredAt: new Date().toISOString(),
    failure: {
      schemaVersion: 1,
      requestId: task.requestId,
      observationId: task.observationId,
      operationId: task.operationId,
      inputFingerprint: task.inputFingerprint,
      stage: parts.stage,
      category: parts.category,
      code,
      executionFact: parts.fact,
      evidenceKey: parts.evidenceKey,
      blockedBy: parts.blockedBy,
      automaticRetry: false,
    },
    observation: parts.observation,
    rawError: { name: parts.error.name, message: code, stack: null, details: parts.error.details },
    candidate: parts.candidate,
    inspection: parts.inspection,
  });
}

/** Appends the Review and reads it back; a lost acknowledgement is checked, never appended twice. */
export async function recordStepReview(
  reviews: ReviewWriter & PrivateReviewReader,
  review: ReviewRecord,
  unconfirmed: () => AppError,
): Promise<void> {
  try {
    await reviews.append(review);
  } catch {
    // The read-back below decides.
  }
  // An unreachable ledger on the read-back is the same as an unconfirmed Review.
  const confirmed = await inspectRegistration(reviews, review).then(
    (registration) => registration.registered,
    () => false,
  );
  if (!confirmed) {
    throw unconfirmed();
  }
}
