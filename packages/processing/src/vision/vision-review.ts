import { isAppError } from "@crawl-automation/platform";
import { safeLabelText } from "@crawl-automation/platform/errors/summary";
import { codexDetailOf } from "../codex/codex-errors.js";
import {
  assessLabelCandidate,
  LabelImageCandidateSchema,
  labelImageIntegrityFindings,
  type LabelFinding,
  type ReviewRecord,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
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
      details: {
        task,
        evidenceKey: key,
        ...(typeof cause === "string" && cause ? { cause } : {}),
        ...labelFindings(attempt.candidate?.value),
        ...repairDetails(attempt),
      },
    },
    candidate: attempt.candidate,
    inspection: { kind: "none" },
  });
}

function repairDetails(attempt: StepAttempt<VisionTask>): { repairCodes?: string[] } {
  const repairCodes = (attempt as StepAttempt<VisionTask> & { repairCodes?: string[] }).repairCodes;
  return repairCodes?.length ? { repairCodes } : {};
}

/**
 * Which label rule rejected the answer and on which row (plan 2026-10-12, part C), recomputed from the kept answer
 * with the rule table at the time of the Review. Details quote label rows and model issues, so they are redacted.
 */
function labelFindings(candidate: unknown): { findings?: LabelFinding[] } {
  const parsed = LabelImageCandidateSchema.safeParse(candidate);
  if (!parsed.success) {
    return {};
  }
  const findings = [
    ...assessLabelCandidate(parsed.data).findings,
    ...labelImageIntegrityFindings(parsed.data),
  ].slice(0, 10);
  return findings.length
    ? {
        findings: findings.map(({ code, detail, rule }) => ({
          code,
          detail: safeLabelText(detail),
          ...(rule ? { rule } : {}),
        })),
      }
    : {};
}
