import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { TextReceiptInputSchema, TextRecordSchema, ReviewRecordSchema, parseTextInput, textObservation,
  type TextReceiptOutcome, type ReviewRecord } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { hashText, type TextHandoff } from "./handoff.js";

/** No model, upload or registration capability: unknown execution means inspect only. */
export class ResolveTextReceipt {
  constructor(private readonly deps: {
    results: Pick<TextHandoff, "inspect">;
    local: ObjectStore;
    reviews: { read(id: string): Promise<ReviewRecord | null>; append(record: ReviewRecord): Promise<unknown> };
  }) {}
  async run(raw: unknown, signal: AbortSignal): Promise<TextReceiptOutcome> {
    const request = TextReceiptInputSchema.parse(raw), input = parseTextInput(request.input, hashText), outcome = request.outcome;
    const receipt = (record: ReviewRecord): TextReceiptOutcome => ({ status: "review", operationId: input.operationId,
      reviewId: record.reviewId, code: record.failure.code, automaticRetry: false });
    try {
      signal.throwIfAborted();
      if (outcome && outcome.operationId !== input.operationId) throw Error("TEXT_RECEIPT.IDENTITY_CONFLICT");
      if (outcome?.status === "review") {
        const saved = await this.deps.reviews.read(outcome.reviewId);
        if (!saved) throw Error("TEXT_RECEIPT.REVIEW_UNVERIFIED");
        const record = ReviewRecordSchema.parse(saved), failure = record.failure;
        if (record.reviewId !== outcome.reviewId || failure.operationId !== input.operationId || failure.inputFingerprint !== input.inputFingerprint ||
          failure.stage !== "codex.text" || failure.code !== outcome.code || !equal(record.observation, textObservation(input)))
          throw Error("TEXT_RECEIPT.IDENTITY_CONFLICT");
        return receipt(record); // Explicit Review is never silently promoted to success.
      }
      const facts = await this.deps.results.inspect(input, signal);
      if (!facts.resultRegistered || !facts.artifactDurable || !facts.record) throw Error("TEXT_RECEIPT.TEXT_UNCONFIRMED");
      const registration = TextRecordSchema.parse(facts.record);
      if (!equal(registration.input, input) || (outcome?.status === "registered" &&
        (!equal(outcome.result, registration.result) || !equal(outcome.completion, registration.completion))))
        throw Error("TEXT_RECEIPT.IDENTITY_CONFLICT");
      return { status: "registered", registration };
    } catch (error) {
      const allowed = ["TEXT_RECEIPT.IDENTITY_CONFLICT", "TEXT_RECEIPT.REVIEW_UNVERIFIED", "TEXT_RECEIPT.TEXT_UNCONFIRMED"];
      const code = error instanceof Error && allowed.includes(error.message) ? error.message : "TEXT_RECEIPT.EVIDENCE_UNVERIFIED";
      const reviewId = `text-receipt-${randomUUID()}`, key = `text-receipt-reviews/${reviewId}.json`;
      const record = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId, occurredAt: new Date().toISOString(),
        failure: { schemaVersion: 1, requestId: input.requestId, observationId: input.observationId, operationId: input.operationId,
          inputFingerprint: input.inputFingerprint, stage: "text.receipt", category: "PROCESSING", code, executionFact: "unknown",
          evidenceKey: key, blockedBy: null, automaticRetry: false }, observation: textObservation(input),
        rawError: { name: "TextReceiptFailure", message: code, stack: null, details: { input, outcome } }, candidate: null, inspection: { kind: "none" } });
      const bytes = Buffer.from(JSON.stringify(record)), retention = AbortSignal.timeout(10000);
      await this.deps.local.create(key, bytes, "application/json", retention);
      const saved = await this.deps.local.read(key, 2 * 1024 * 1024, retention);
      if (!saved || !Buffer.from(saved).equals(bytes)) throw Error("TEXT_RECEIPT.LOCAL_UNVERIFIED");
      try { await this.deps.reviews.append(record); } catch { /* Read back the exact ID; never append twice. */ }
      const confirmed = await this.deps.reviews.read(reviewId);
      if (!confirmed || !equal(ReviewRecordSchema.parse(confirmed), record)) throw Error("TEXT_RECEIPT.REVIEW_UNVERIFIED");
      return receipt(record);
    }
  }
}
