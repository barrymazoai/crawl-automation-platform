import { isDeepStrictEqual } from "node:util";
import {
  LabelImageCandidateSchema,
  LabelReviewedImageRecordSchema,
  type ReviewRecord,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import type { VisionEvidence } from "./vision-evidence.js";
import { visionFailure } from "./vision-errors.js";
import { visionKeys, visionRef, visionTaskFingerprint } from "./vision-files.js";

/** Reuse the normal original/OCR/intent/response verification; retain the Review as provenance. */
export async function readReviewedLabelImage(
  evidence: VisionEvidence,
  at: { task: VisionTask; review: ReviewRecord },
  signal: AbortSignal,
) {
  const { task, review } = at;
  if (
    review.failure.executionFact !== "executed" ||
    review.failure.inputFingerprint !== visionTaskFingerprint(task) ||
    review.failure.evidenceKey !== visionKeys.response(task)
  ) {
    throw visionFailure("VISION.EVIDENCE_CONFLICT", "unknown");
  }
  const answer = await evidence.read(task, { allowLocal: false }, signal);
  const candidate = LabelImageCandidateSchema.parse(answer.candidate);
  if (
    review.candidate?.schema !== "label-extraction/1" ||
    !isDeepStrictEqual(candidate, review.candidate.value)
  ) {
    throw visionFailure("VISION.EVIDENCE_CONFLICT", "unknown");
  }
  const record = LabelReviewedImageRecordSchema.parse({
    codec: "vision-reviewed/1",
    ...task,
    review,
    result: visionRef(task, { name: "response", data: answer.bytes }),
  });
  return { record, candidate };
}
