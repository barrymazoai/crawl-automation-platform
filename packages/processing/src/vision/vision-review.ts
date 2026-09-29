import { isAppError } from "@crawl-automation/platform";
import { codexDetailOf } from "../codex/codex-errors.js";
import type { ReviewRecord, VisionTask } from "@crawl-automation/v3-contracts";
import type { StepAttempt, StepFailure } from "../step/processing-step.js";
import { buildStepReview, newReviewId } from "../step/step-review.js";
import { visionKeys, visionTaskFingerprint } from "./vision-files.js";

/** The file a Review points to: the recorded call failure, the model's answer, or the intent. */
function evidenceKey(task: VisionTask, attempt: StepAttempt<VisionTask>, code: string): string {
  if (code.startsWith("VISION.CODEX_")) {
    return visionKeys.failure(task);
  }
  return attempt.candidate ? visionKeys.response(task) : visionKeys.intent(task);
}

/** The Review of a failed vision task, with the decoded answer when there was one. Never retried automatically. */
export function visionReview(attempt: StepAttempt<VisionTask>, failure: StepFailure): ReviewRecord {
  const task = attempt.input;
  const owner = task.input.selection.observation;
  const key = evidenceKey(task, attempt, failure.code);
  const cause =
    codexDetailOf(failure.error) ??
    (isAppError(failure.error) ? failure.error.details["cause"] : undefined);
  return buildStepReview({
    reviewId: newReviewId("vision"),
    task: {
      requestId: owner.requestId,
      observationId: owner.observationId,
      operationId: task.input.operationId,
      inputFingerprint: visionTaskFingerprint(task),
    },
    observation: owner,
    stage: "codex.vision",
    category: "PROCESSING",
    code: failure.code,
    fact: failure.fact,
    evidenceKey: key,
    blockedBy: null,
    error: {
      name: "VisionReview",
      details: { task, evidenceKey: key, ...(typeof cause === "string" && cause ? { cause } : {}) },
    },
    candidate: attempt.candidate,
    inspection: { kind: "none" },
  });
}
