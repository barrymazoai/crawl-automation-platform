import { randomUUID } from "node:crypto";
import {
  ReviewRecordSchema,
  textObservation,
  type ReviewRecord,
  type TextInput,
  type TextOutput,
} from "@crawl-automation/v3-contracts";
import {
  inspectRegistration,
  type PrivateReviewReader,
  type ReviewWriter,
} from "@crawl-automation/v3-review";
import { isAppError } from "@crawl-automation/platform";
import { CodexError } from "@crawl-automation/v3-codex";
import { executionFactOf, isKnownTextFailure, textFailure, type ExecutionFact } from "../errors.js";
import { textKeys } from "../results/text-record.js";
import { textReviewFailure } from "./review-failure.js";

export interface TextReviewCase {
  input: TextInput;
  error: unknown;
  /** Whether the model had already run when the step failed. */
  fact: ExecutionFact;
  output: TextOutput | null;
  response: string | null;
  aborted: boolean;
}

/** The failure's own code (the text step's or the model client's); otherwise cancelled or unclassified. */
function failureCode(failure: TextReviewCase): string {
  if (isKnownTextFailure(failure.error)) {
    return failure.error.code;
  }
  return failure.aborted ? "TEXT.CANCELLED" : "TEXT.UNCLASSIFIED";
}

/** What the model client reported, or the error that caused this failure. */
function failureCause(error: unknown): unknown {
  if (error instanceof CodexError) {
    return error.detail;
  }
  return isAppError(error) ? error.details["cause"] : undefined;
}

/** The Review of a failed text task, with the model's answer when there was one. Never retried automatically. */
export function textReview(failure: TextReviewCase): ReviewRecord {
  const { input } = failure;
  const code = failureCode(failure);
  const ownFact = executionFactOf(failure.error);
  const fact = failure.fact !== "executed" && ownFact ? ownFact : failure.fact;
  const cause = failureCause(failure.error);
  const blockedBy =
    input.source.kind === "ocr" && fact === "not_executed"
      ? input.source.registration.input.operationId
      : null;
  return ReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId: `text-${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    failure: textReviewFailure(input, {
      stage: "codex.text",
      code,
      executionFact: fact,
      evidenceKey: textKeys.intent(input),
      blockedBy,
    }),
    observation: textObservation(input),
    rawError: {
      name: "TextStageError",
      message: code,
      stack: null,
      details: {
        code,
        executionFact: fact,
        ...(typeof cause === "string" && cause ? { cause } : {}),
      },
    },
    candidate: reviewCandidate(failure),
    inspection: { kind: "none" },
  });
}

function reviewCandidate(failure: TextReviewCase) {
  if (failure.output) {
    return { schema: "text-output/1", value: failure.output };
  }
  if (failure.response !== null) {
    return { schema: "text-raw-response/1", value: { rawResponse: failure.response } };
  }
  return null;
}

/** Appends the Review and reads it back; a lost acknowledgement is checked, never appended twice. */
export async function recordTextReview(
  reviews: ReviewWriter & PrivateReviewReader,
  review: ReviewRecord,
): Promise<void> {
  try {
    await reviews.append(review);
  } catch {
    if (!(await inspectRegistration(reviews, review)).registered) {
      throw textFailure("TEXT.REVIEW_UNKNOWN");
    }
  }
  if (!(await inspectRegistration(reviews, review)).registered) {
    throw textFailure("TEXT.REVIEW_UNKNOWN");
  }
}
