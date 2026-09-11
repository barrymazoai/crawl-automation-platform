import { randomUUID } from "node:crypto";
import { OcrReceiptInputSchema, OcrRegistrationSchema, ReviewRecordSchema, parseOcrInput, observationIdentity,
  type OcrReceiptOutcome, type OcrRegistration, type ReviewRecord } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { digest } from "@crawl-automation/v3-vision";

/** Read-only reconciliation of upstream evidence, never an OCR provider or an upload/registration retry. */
export class ResolveOcrReceipt {
  constructor(private readonly deps: {
    results: { inspect(input: unknown, signal: AbortSignal): Promise<{ resultRegistered: boolean; artifactDurable: boolean; record: OcrRegistration | null }> };
    reviews: { read(id: string): Promise<ReviewRecord | null>; append(record: ReviewRecord): Promise<unknown> };
    local: ObjectStore;
  }) {}
  async run(raw: unknown, signal: AbortSignal): Promise<OcrReceiptOutcome> {
    const request = OcrReceiptInputSchema.parse(raw), input = parseOcrInput(request.input, digest), outcome = request.outcome;
    const reviewReceipt = (r: ReviewRecord): OcrReceiptOutcome => ({ status: "review", imageId: input.file.artifactId,
      operationId: input.operationId, reviewId: r.reviewId, code: r.failure.code, automaticRetry: false });
    try {
      if (outcome && outcome.operationId !== input.operationId) throw Error("RECEIPT.IDENTITY_CONFLICT");
      if (outcome?.status === "review") {
        const stored = await this.deps.reviews.read(outcome.reviewId);
        if (!stored) throw Error("RECEIPT.REVIEW_UNVERIFIED");
        const r = ReviewRecordSchema.parse(stored);
        if (r.reviewId !== outcome.reviewId || r.failure.operationId !== input.operationId || r.failure.inputFingerprint !== input.inputFingerprint ||
          r.failure.code !== outcome.code || r.failure.evidenceKey !== outcome.evidenceKey || r.failure.stage !== "ocr.file" ||
          JSON.stringify(r.observation) !== JSON.stringify(observationIdentity(input)) || r.inspection.kind !== "ocr-result" ||
          JSON.stringify(r.inspection.input) !== JSON.stringify(input)) throw Error("RECEIPT.IDENTITY_CONFLICT");
        return reviewReceipt(r); // Explicit upstream Review stays Review; never silently promote it.
      }
      const facts = await this.deps.results.inspect(input, signal);
      if (!facts.resultRegistered || !facts.artifactDurable || !facts.record) throw Error("RECEIPT.OCR_UNCONFIRMED");
      const registration = OcrRegistrationSchema.parse(facts.record);
      if (JSON.stringify(registration.input) !== JSON.stringify(input) || (outcome?.status === "registered" &&
        (JSON.stringify(outcome.result) !== JSON.stringify(registration.result) || JSON.stringify(outcome.completion) !== JSON.stringify(registration.completion))))
        throw Error("RECEIPT.IDENTITY_CONFLICT");
      return { status: "registered", registration };
    } catch (error) {
      const allowed = ["RECEIPT.IDENTITY_CONFLICT", "RECEIPT.REVIEW_UNVERIFIED", "RECEIPT.OCR_UNCONFIRMED"];
      const code = error instanceof Error && allowed.includes(error.message) ? error.message : "RECEIPT.EVIDENCE_UNVERIFIED";
      const reviewId = `receipt-${randomUUID()}`, key = `ocr-receipt-reviews/${reviewId}.json`;
      const record = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId, occurredAt: new Date().toISOString(),
        failure: { schemaVersion: 1, requestId: input.requestId, observationId: input.observationId, operationId: input.operationId,
          inputFingerprint: input.inputFingerprint, stage: "ocr.receipt", category: "PROCESSING", code, executionFact: "unknown",
          evidenceKey: key, blockedBy: null, automaticRetry: false }, observation: observationIdentity(input),
        rawError: { name: "OcrReceiptFailure", message: code, stack: null, details: { outcome } }, candidate: null,
        inspection: { kind: "ocr-result", input } });
      const bytes = Buffer.from(JSON.stringify(record)), retention = AbortSignal.timeout(10000);
      await this.deps.local.create(key, bytes, "application/json", retention);
      const saved = await this.deps.local.read(key, 2 * 1024 * 1024, retention);
      if (!saved || digest(saved) !== digest(bytes)) throw Error("RECEIPT.LOCAL_UNVERIFIED");
      try { await this.deps.reviews.append(record); } catch { /* Only read back this exact Review ID. */ }
      const confirmed = await this.deps.reviews.read(record.reviewId);
      if (!confirmed || digest(JSON.stringify(ReviewRecordSchema.parse(confirmed))) !== digest(bytes)) throw Error("RECEIPT.REVIEW_UNVERIFIED");
      return reviewReceipt(record);
    }
  }
}
