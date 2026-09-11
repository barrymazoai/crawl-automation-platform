import { randomUUID } from "node:crypto";
import { DefaultKeywordPolicy, KeywordResultSchema, OcrRegistrationSchema, ReviewRecordSchema,
  observationIdentity, type KeywordResult, type ReviewRecord } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { digest } from "./keywords.js";

export const keywordCompatibility = `keywords-${digest(JSON.stringify(DefaultKeywordPolicy)).slice(0, 32)}`;
export const keywordKey = (r: KeywordResult) => `v3/keywords/${r.ocrOperationId}/${r.policyFingerprint}.json`;
/** Only verified OCR may reach publication. A replay never re-PUTs an existing decision. */
export class KeywordPublication {
  constructor(private readonly local: ObjectStore, private readonly remote: ObjectStore) {}
  async publish(raw: KeywordResult, signal: AbortSignal) {
    const result = KeywordResultSchema.parse(raw), key = keywordKey(result), bytes = Buffer.from(JSON.stringify(result));
    const verify = (saved: Uint8Array | null) => {
      if (!saved || !Buffer.from(saved).equals(bytes)) throw Error("SCREEN.PUBLICATION_CONFLICT");
    };
    const existing = await this.remote.read(key, 1024 * 1024, signal);
    if (existing) { verify(existing); return { evidenceKey: key }; }
    // Prior local output is evidence of an unfinished handoff, not permission to retry publication.
    const prior = await this.local.read(key, 1024 * 1024, signal);
    if (prior) { verify(prior); throw Error("SCREEN.HANDOFF_PENDING"); }
    await this.local.create(key, bytes, "application/json", signal);
    verify(await this.local.read(key, 1024 * 1024, signal));
    try { await this.remote.create(key, bytes, "application/json", signal); } catch { /* read-only reconciliation */ }
    verify(await this.remote.read(key, 1024 * 1024, signal));
    return { evidenceKey: key };
  }
}
export function keywordReviewWriter(local: ObjectStore, reviews: { append(record: ReviewRecord): Promise<{ reviewId: string }> }) {
  return async (raw: unknown, code: string, signal: AbortSignal) => {
    const registration = OcrRegistrationSchema.parse(raw), input = registration.input;
    const record = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: `screen-${randomUUID()}`, occurredAt: new Date().toISOString(),
      failure: { schemaVersion: 1, requestId: input.requestId, observationId: input.observationId,
        operationId: `screen-${digest(JSON.stringify([input.operationId, keywordCompatibility]))}`,
        inputFingerprint: digest(JSON.stringify(registration)), stage: "ocr.keywords", category: "PROCESSING", code,
        executionFact: "unknown", evidenceKey: registration.result.objectKey, blockedBy: null, automaticRetry: false },
      observation: observationIdentity(input), rawError: { name: "KeywordStageError", message: code, stack: null, details: { registration } },
      candidate: null, inspection: { kind: "none" } });
    const key = `keyword-reviews/${record.reviewId}.json`, bytes = Buffer.from(JSON.stringify(record));
    await local.create(key, bytes, "application/json", signal);
    const saved = await local.read(key, 2 * 1024 * 1024, signal);
    if (!saved || !Buffer.from(saved).equals(bytes)) throw Error("SCREEN.REVIEW_UNVERIFIED");
    const receipt = await reviews.append(record); return { reviewId: receipt.reviewId };
  };
}
