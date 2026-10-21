import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ObjectStore } from "@crawl-automation/platform";
import {
  VisionTaskSchema,
  type ReviewRecord,
  type VisionRecord,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import { decodeJson, hashString } from "../results/result-record.js";
import { recheckErrors } from "../recheck/errors.js";
import { decodeVisionResult } from "./protocol/vision-protocol.js";
import {
  VisionResponseSchema,
  visionKeys,
  visionLimits,
  visionTaskFingerprint,
} from "./vision-files.js";

/** The retained response is tied to the Review's exact task, not to today's worker setup. */
export async function retainedVisionReviewAnswer(
  review: ReviewRecord,
  objects: Pick<ObjectStore, "read">,
  signal: AbortSignal,
) {
  const task = reviewedVisionTask(review);
  signal.throwIfAborted();
  const bytes = await objects.read(visionKeys.response(task), visionLimits.responseBytes, signal);
  if (!bytes) {
    throw recheckErrors.create("RECHECK.EVIDENCE_UNAVAILABLE");
  }
  const response = VisionResponseSchema.parse(decodeJson(bytes));
  if (
    response.fingerprint !== visionTaskFingerprint(task) ||
    response.sha256 !== hashString(response.raw)
  ) {
    throw recheckErrors.create("RECHECK.IDENTITY_CONFLICT");
  }
  return { task, bytes, response, decoded: decodeVisionResult(task.input, response.raw) };
}

export function reviewedVisionTask(review: ReviewRecord): VisionTask {
  const details = z.object({ task: z.unknown() }).safeParse(review.rawError.details);
  const task = VisionTaskSchema.safeParse(details.success ? details.data.task : null);
  if (!task.success || !task.data.input.extractionProtocol) {
    throw recheckErrors.create("RECHECK.EVIDENCE_UNAVAILABLE");
  }
  const own =
    review.failure.stage === "codex.vision" &&
    review.failure.executionFact === "executed" &&
    review.failure.operationId === task.data.input.operationId &&
    review.failure.inputFingerprint === visionTaskFingerprint(task.data) &&
    review.failure.evidenceKey === visionKeys.response(task.data) &&
    isDeepStrictEqual(review.observation, task.data.input.selection.observation);
  if (!own) {
    throw recheckErrors.create("RECHECK.IDENTITY_CONFLICT");
  }
  return task.data;
}

export function isRetainedVisionReview(review: ReviewRecord): boolean {
  return (
    review.failure.stage === "codex.vision" &&
    (review.candidate?.schema === "label-extraction/1" ||
      /^v3\/vision\/[^/]+\/response\.json$/.test(review.failure.evidenceKey))
  );
}

/** A staged result must belong to the exact task and original Review before registration. */
export function isReviewedVisionRecord(review: ReviewRecord, record: VisionRecord): boolean {
  const task = reviewedVisionTask(review);
  return (
    isRetainedVisionReview(review) &&
    isDeepStrictEqual(record.input, task.input) &&
    record.configFingerprint === task.configFingerprint &&
    record.result.objectKey === review.failure.evidenceKey
  );
}

export type RetainedVisionAnswer = Awaited<ReturnType<typeof retainedVisionReviewAnswer>>;
export type RetainedVisionTask = VisionTask;
