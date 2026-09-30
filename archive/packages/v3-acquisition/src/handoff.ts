import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { FileAcquireInputSchema, AcquiredFileRecordSchema, ImageOcrPrepareInputSchema, OcrInputSchema, ReviewRecordSchema,
  observationIdentity, fingerprintOcrInput, type FileAcquireInput, type FileAcquireOutcome, type AcquiredFileRecord, type ReviewRecord, type ImageOcrPrepareOutcome } from "@crawl-automation/v3-contracts";
import { ArtifactResolver, verifyBytes, type ObjectStore, type LocalCopies } from "@crawl-automation/v3-artifacts";
import { hash, verifyInput } from "./core.js";
import { acquireFile, FILE_CONFIG_FINGERPRINT } from "./file.js";
import type { SourceAccess, DnsResolver } from "./ports.js";
export const acquiredImageId = (operationId: string) => `file-${hash(operationId)}`;
export const acquisitionKey = (input: FileAcquireInput) => `v3/acquisition/${input.operationId}/completion.json`;
const intentSchema = z.strictObject({ input: FileAcquireInputSchema, nonce: z.uuid() });
type Reviews = { read(id: string): Promise<ReviewRecord | null>; append(r: ReviewRecord): Promise<unknown> };
type Evidence = { local: ObjectStore; remote: ObjectStore; copies: LocalCopies; reviews: Reviews };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Shared read/publication mechanics; no source HTTP capability. */
export class FileEvidence {
  constructor(readonly deps: Evidence) {}
  async inspect(raw: FileAcquireInput, signal: AbortSignal): Promise<AcquiredFileRecord | null> {
    const input = FileAcquireInputSchema.parse(raw); verifyInput(input, FILE_CONFIG_FINGERPRINT);
    const bytes = await this.deps.remote.read(acquisitionKey(input), 65536, signal);
    if (!bytes) return null;
    const record = AcquiredFileRecordSchema.parse(JSON.parse(Buffer.from(bytes).toString()));
    if (!equal(record.input, input) || record.file.artifactId !== acquiredImageId(input.operationId) ||
      record.file.objectKey !== `v3/${input.observationId}/${input.operationId}/source` ||
      (input.expectedSha256 !== null && input.expectedSha256 !== record.file.sha256)) throw Error("ACQUIRE.EVIDENCE_CONFLICT");
    const content = await this.deps.remote.read(record.file.objectKey, record.file.byteSize, signal);
    if (!content) throw Error("ACQUIRE.NOT_DURABLE");
    verifyBytes(record.file, content, 32 * 1024 * 1024);
    return record;
  }
  async publish(key: string, value: unknown, signal: AbortSignal) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 65536) throw Error("ACQUIRE.OUTPUT_LIMIT");
    const verify = (actual: Uint8Array | null) => { if (!actual || hash(actual) !== hash(bytes)) throw Error("ACQUIRE.HANDOFF_UNVERIFIED"); };
    const prior = await this.deps.remote.read(key, 65536, signal);
    if (prior) { verify(prior); return; }
    if (await this.deps.local.read(key, 65536, signal)) throw Error("ACQUIRE.HANDOFF_PENDING");
    await this.deps.local.create(key, bytes, "application/json", signal);
    verify(await this.deps.local.read(key, 65536, signal));
    try { await this.deps.remote.create(key, bytes, "application/json", signal); } catch { /* GET only; no second PUT. */ }
    verify(await this.deps.remote.read(key, 65536, signal));
  }
  async review(input: FileAcquireInput, stage: "file.acquire" | "image.ocr-input", error: unknown, candidate: unknown = null): Promise<Extract<FileAcquireOutcome, { status: "review" }>> {
    const rawCode = error instanceof Error ? ("code" in error ? String(error.code) : error.message) : "";
    const allowed = /^(ACQUIRE|SOURCE|ARTIFACT|INPUT|RUNTIME|IMAGE)\.[A-Z_]+$/;
    const code = allowed.test(rawCode) ? rawCode : "ACQUIRE.UNRESOLVED", reviewId = `acquire-${randomUUID()}`, key = `acquisition-reviews/${reviewId}.json`;
    const review = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId, occurredAt: new Date().toISOString(),
      failure: { schemaVersion: 1, requestId: input.requestId, observationId: input.observationId, operationId: input.operationId,
        inputFingerprint: input.inputFingerprint, stage, category: "ARTIFACT", code, executionFact: "unknown", evidenceKey: key, blockedBy: null, automaticRetry: false },
      observation: observationIdentity(input), rawError: { name: "AcquisitionFailure", message: code, stack: null, details: { input } },
      candidate: candidate ? { schema: "acquisition-evidence/1", value: candidate } : null, inspection: { kind: "none" } });
    const bytes = Buffer.from(JSON.stringify(review)), signal = AbortSignal.timeout(10000);
    await this.deps.local.create(key, bytes, "application/json", signal);
    const saved = await this.deps.local.read(key, 2 * 1024 * 1024, signal);
    if (!saved || hash(saved) !== hash(bytes)) throw Error("ACQUIRE.REVIEW_UNVERIFIED");
    try { await this.deps.reviews.append(review); } catch { /* Read the same Review ID, never append another. */ }
    const confirmed = await this.deps.reviews.read(reviewId);
    // jsonb may reorder keys inside untyped JSON details/candidates; compare values, not serialization order.
    if (!confirmed || !isDeepStrictEqual(ReviewRecordSchema.parse(confirmed), review)) throw Error("ACQUIRE.REVIEW_UNVERIFIED");
    return { status: "review", operationId: input.operationId, reviewId, evidenceKey: key, code, automaticRetry: false };
  }
}
export class AcquireFileModule {
  constructor(private readonly evidence: FileEvidence, private readonly source: { access: SourceAccess; dns: DnsResolver }) {}
  async run(raw: unknown, signal: AbortSignal): Promise<FileAcquireOutcome> {
    const input = FileAcquireInputSchema.parse(raw); let record: AcquiredFileRecord | null = null;
    const receipt = (r: AcquiredFileRecord): FileAcquireOutcome => ({ status: "durable", operationId: input.operationId, file: r.file, evidenceKey: acquisitionKey(input) });
    try {
      verifyInput(input, FILE_CONFIG_FINGERPRINT);
      const prior = await this.evidence.inspect(input, signal); if (prior) return receipt(prior);
      const key = `acquisition-intents/${input.operationId}.json`, proposed = intentSchema.parse({ input, nonce: randomUUID() });
      let created: "created" | "exists";
      try { created = await this.evidence.deps.remote.create(key, Buffer.from(JSON.stringify(proposed)), "application/json", signal); }
      catch { throw Error("ACQUIRE.INTENT_UNKNOWN"); }
      const saved = await this.evidence.deps.remote.read(key, 65536, signal);
      if (!saved || !equal(intentSchema.parse(JSON.parse(Buffer.from(saved).toString())), proposed)) {
        if (created === "exists") throw Error("ACQUIRE.EXECUTION_UNKNOWN");
        throw Error("ACQUIRE.INTENT_UNKNOWN");
      }
      if (created !== "created") throw Error("ACQUIRE.EXECUTION_UNKNOWN");
      const acquired = await acquireFile(input, this.source, signal);
      record = AcquiredFileRecordSchema.parse({ schemaVersion: 1, codec: "acquired-file/1", input,
        file: acquired.file, dimensions: acquired.dimensions, redirects: acquired.redirects });
      // Retain accepted bytes even after a late cancellation. No remote writes in this retention step.
      await this.evidence.deps.copies.retain(record.file, acquired.bytes, AbortSignal.timeout(10000));
      await new ArtifactResolver(this.evidence.deps.copies, this.evidence.deps.remote).publish(record.file, observationIdentity(input), acquired.bytes, signal);
      await this.evidence.publish(acquisitionKey(input), record, signal);
      const verified = await this.evidence.inspect(input, signal); if (!verified) throw Error("ACQUIRE.NOT_DURABLE");
      return receipt(verified);
    } catch (error) {
      // A durable completion with a lost response may be used; never download or PUT again here.
      try { const verified = await this.evidence.inspect(input, AbortSignal.timeout(10000)); if (verified) return receipt(verified); } catch { /* Preserve unknown. */ }
      return this.evidence.review(input, "file.acquire", error, record);
    }
  }
}
/** Read-only handoff for an already acquired file. No download/PUT/review mutation capability. */
export class ResolveAcquiredFile {
  constructor(private readonly evidence: Pick<FileEvidence, "inspect">) {}
  async run(raw: unknown, signal: AbortSignal): Promise<FileAcquireOutcome> {
    const input = FileAcquireInputSchema.parse(raw);
    signal.throwIfAborted();
    const record = await this.evidence.inspect(input, signal);
    signal.throwIfAborted();
    if (!record) throw Error("ACQUIRE.NOT_DURABLE");
    return { status: "durable", operationId: input.operationId, file: record.file, evidenceKey: acquisitionKey(input) };
  }
}
/** Pure task construction plus source evidence verification/publication; no download, resize, OCR, or image model. */
export class PrepareImageOcr {
  constructor(private readonly evidence: FileEvidence) {}
  async run(raw: unknown, signal: AbortSignal): Promise<ImageOcrPrepareOutcome> {
    const { plan, receipt } = ImageOcrPrepareInputSchema.parse(raw), input = plan.acquire;
    try {
      if (plan.imageId !== acquiredImageId(input.operationId) || (receipt && receipt.operationId !== input.operationId)) throw Error("IMAGE.IDENTITY_CONFLICT");
      if (receipt?.status === "review") {
        const stored = await this.evidence.deps.reviews.read(receipt.reviewId);
        if (!stored) throw Error("ACQUIRE.REVIEW_UNVERIFIED");
        const r = ReviewRecordSchema.parse(stored);
        if (r.failure.operationId !== input.operationId || r.failure.inputFingerprint !== input.inputFingerprint || r.failure.stage !== "file.acquire" ||
          r.failure.code !== receipt.code || r.failure.evidenceKey !== receipt.evidenceKey || !equal(r.observation, observationIdentity(input))) throw Error("IMAGE.IDENTITY_CONFLICT");
        return receipt;
      }
      const record = await this.evidence.inspect(input, signal); if (!record) throw Error("ACQUIRE.NOT_DURABLE");
      if (receipt?.status === "durable" && (!equal(receipt.file, record.file) || receipt.evidenceKey !== acquisitionKey(input))) throw Error("IMAGE.IDENTITY_CONFLICT");
      if (record.file.kind !== "source-image") throw Error("IMAGE.PDF_ROUTE_REQUIRED");
      const unsigned = { ...observationIdentity(input), ...plan.ocr, operationId: plan.ocrOperationId, file: record.file };
      const task = OcrInputSchema.parse({ ...unsigned, inputFingerprint: fingerprintOcrInput(unsigned, hash) });
      const key = `v3/acquisition/${input.operationId}/ocr-${plan.ocrOperationId}.json`;
      await this.evidence.publish(key, { schemaVersion: 1, codec: "image-ocr-input/1", plan, acquisition: record, task }, signal);
      return { status: "prepared", task, evidenceKey: key };
    } catch (error) { return this.evidence.review(input, "image.ocr-input", error, { plan }); }
  }
}
