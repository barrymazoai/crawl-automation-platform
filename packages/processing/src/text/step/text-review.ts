import { textObservation, type ReviewRecord, type TextInput } from "@crawl-automation/v3-contracts";
import { isAppError } from "@crawl-automation/platform";
import { CodexError } from "@crawl-automation/platform";
import type { StepAttempt, StepFailure } from "../../step/processing-step.js";
import { buildStepReview, newReviewId } from "../../step/step-review.js";
import { textKeys } from "../results/text-record.js";

/** What the model client reported, or the error that caused this failure. */
function failureCause(error: unknown): unknown {
  if (error instanceof CodexError) {
    return error.detail;
  }
  return isAppError(error) ? error.details["cause"] : undefined;
}

/** The Review of a failed text task, with the model's answer when there was one. Never retried automatically. */
export function textReview(attempt: StepAttempt<TextInput>, failure: StepFailure): ReviewRecord {
  const { input } = attempt;
  const { code, fact } = failure;
  const cause = failureCause(failure.error);
  const blockedBy =
    input.source.kind === "ocr" && fact === "not_executed"
      ? input.source.registration.input.operationId
      : null;
  return buildStepReview({
    reviewId: newReviewId("text"),
    task: input,
    observation: textObservation(input),
    stage: "codex.text",
    category: "PROCESSING",
    code,
    fact,
    evidenceKey: textKeys.intent(input),
    blockedBy,
    error: {
      name: "TextStageError",
      details: {
        code,
        executionFact: fact,
        ...(typeof cause === "string" && cause ? { cause } : {}),
      },
    },
    candidate: attempt.candidate,
    inspection: { kind: "none" },
  });
}
