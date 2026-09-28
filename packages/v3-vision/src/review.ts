import { randomUUID } from "node:crypto";
import { ReviewRecordSchema, VisionTaskSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import type { VisionOutcome } from "./module.js";
import { visionFingerprint } from "./handoff.js";
/** Persist locally before DB append. No raw exception/configuration can leak into a review. */
export function visionReviewWriter(local: ObjectStore, reviews: { append(record: ReviewRecord): Promise<{ reviewId: string }> }) {
  return async (raw: unknown, outcome: VisionOutcome, signal: AbortSignal) => {
    const task = VisionTaskSchema.parse(raw), owner = task.input.selection.observation;
    const record = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: `vision-${randomUUID()}`, occurredAt: new Date().toISOString(),
      failure: { schemaVersion: 1, requestId: owner.requestId, observationId: owner.observationId, operationId: task.input.operationId,
        inputFingerprint: visionFingerprint(task), stage: "codex.vision", category: "PROCESSING", code: outcome.code,
        executionFact: outcome.candidate ? "executed" : outcome.code === "VISION.CONFIG_MISMATCH" ? "not_executed" : "unknown",
        evidenceKey: outcome.evidenceKey, blockedBy: null, automaticRetry: false },
      observation: owner, rawError: { name: "VisionReview", message: outcome.code, stack: null,
        details: { task, evidenceKey: outcome.evidenceKey, ...(outcome.detail ? { cause: outcome.detail } : {}) } },
      candidate: outcome.candidate ? { schema: task.input.extractionProtocol ? "label-extraction/1" : "vision-candidate/1",
        value: outcome.candidate } : null, inspection: { kind: "none" } });
    const bytes = Buffer.from(JSON.stringify(record)), key = `vision-reviews/${record.reviewId}.json`;
    await local.create(key, bytes, "application/json", signal);
    const saved = await local.read(key, 2 * 1024 * 1024, signal);
    if (!saved || !Buffer.from(saved).equals(bytes)) throw Error("VISION.REVIEW_UNVERIFIED");
    const receipt = await reviews.append(record);
    return { reviewId: receipt.reviewId };
  };
}
