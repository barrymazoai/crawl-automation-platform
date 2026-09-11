import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { PdfCompletionSchema, PdfDataSchema, ReviewRecordSchema, observationIdentity, assertArtifactBelongsTo,
  type PdfInput, type PdfCompletion, type PdfActivityOutcome, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { ArtifactResolver, sha256, verifyBytes, type ObjectStore, type LocalCopies } from "@crawl-automation/v3-artifacts";
import { inputChecked, type PdfSubprocess, type PdfPrepared } from "./runtime.js";
import policy from "../policy.json";

export type PdfEvidenceDependencies = { remote: ObjectStore; journal: ObjectStore; copies: LocalCopies;
  reviews: { read(id: string): Promise<ReviewRecord | null>; append(record: ReviewRecord): Promise<unknown> } };
export const pdfCompletionKey = (i: PdfInput) => `v3/pdf/${i.operationId}/completion.json`;
export const pdfAttemptKey = (i: PdfInput) => `pdf-attempts/${i.operationId}.json`;
const parse = (bytes: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

/** Read-only validation works without Python, its original node, or that node's attempt path. */
function validateOutput(record: PdfCompletion, bytes: Uint8Array) {
  const { input: i, manifest: m, artifact: a } = record, render = i.module === "pdf.render";
  assertArtifactBelongsTo(a, observationIdentity(i));
  if (m.operationId !== i.operationId || m.inputFingerprint !== i.inputFingerprint || m.sourceSha256 !== i.pdf.sha256 || m.module !== i.module ||
    m.pageIndex !== (i.module === "pdf.inspect" ? null : i.pageIndex) || m.scale !== (render ? i.scale : null) ||
    m.filename !== (render ? "output.png" : "output.json") || m.engine.pypdfium2 !== policy.pypdfium2 ||
    m.engine.pdfium !== policy.pdfium || m.engine.pillow !== policy.pillow || a.sha256 !== m.sha256 || a.byteSize !== m.byteSize ||
    a.artifactId !== `pdf-${i.inputFingerprint}` || a.objectKey !== `v3/${i.observationId}/${i.operationId}/${i.inputFingerprint}/${m.filename}` ||
    !equal(a.producer, { operationId: i.operationId, module: i.module, implementationVersion: i.implementationVersion })) throw Error("PDF.RESULT_INTEGRITY");
  verifyBytes(a, bytes, policy.maxOutputBytes);
  if (render) {
    const b = Buffer.from(bytes);
    if (a.kind !== "pdf-page" || a.mediaType !== "image/png" || a.parentArtifactId !== i.pdf.artifactId || a.pageIndex !== i.pageIndex ||
      m.width === null || m.height === null || m.width * m.height > policy.maxPixels || b.length < 33 ||
      b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || b.readUInt32BE(8) !== 13 || b.toString("ascii", 12, 16) !== "IHDR" ||
      b.readUInt32BE(16) !== m.width || b.readUInt32BE(20) !== m.height) throw Error("PDF.RESULT_INTEGRITY");
  } else {
    if (a.kind !== "result-json" || m.width !== null || m.height !== null) throw Error("PDF.RESULT_INTEGRITY");
    const data = PdfDataSchema.parse(parse(bytes));
    if (i.module === "pdf.inspect") {
      if (data.kind !== "inspect" || data.pages.length !== data.pageCount || data.pages.some((p, n) => p.pageIndex !== n)) throw Error("PDF.RESULT_INTEGRITY");
    } else if (data.kind !== "text" || data.pageIndex !== i.pageIndex || data.hasText !== /[^ \t\r\n\f\v\u00a0]/u.test(data.text) ||
      Buffer.byteLength(data.text) > policy.maxTextBytes || [...data.text].length > policy.maxTextChars) throw Error("PDF.RESULT_INTEGRITY");
  }
}

export class PdfEvidence {
  constructor(protected readonly deps: PdfEvidenceDependencies) {}
  async inspect(raw: unknown, signal: AbortSignal): Promise<PdfCompletion | null> {
    const input = inputChecked(raw), bytes = await this.deps.remote.read(pdfCompletionKey(input), 65536, signal);
    if (!bytes) return null;
    const record = PdfCompletionSchema.parse(parse(bytes));
    if (!equal(record.input, input)) throw Error("PDF.RESULT_INTEGRITY");
    const source = await this.deps.remote.read(input.pdf.objectKey, input.pdf.byteSize, signal);
    if (!source) throw Error("PDF.NOT_DURABLE");
    verifyBytes(input.pdf, source, policy.maxInputBytes);
    const result = await this.deps.remote.read(record.artifact.objectKey, Math.min(record.artifact.byteSize, policy.maxOutputBytes), signal);
    if (!result) throw Error("PDF.NOT_DURABLE");
    validateOutput(record, result);
    return record;
  }
}
export class PdfModule extends PdfEvidence {
  constructor(deps: PdfEvidenceDependencies, private readonly engine: Pick<PdfSubprocess, "run">) { super(deps); }
  async run(raw: unknown, signal: AbortSignal): Promise<PdfActivityOutcome> {
    const input = inputChecked(raw), key = pdfCompletionKey(input); let computed: PdfPrepared | null = null, attemptId: string | null = null;
    const receipt = (r: PdfCompletion): PdfActivityOutcome => ({ status: "durable", operationId: input.operationId, artifact: r.artifact, evidenceKey: key });
    try {
      const prior = await this.inspect(input, signal); if (prior) return receipt(prior);
      // The shared intent is permanent. A fresh node must not steal unknown work on timeout/restart.
      const intentKey = `pdf-intents/${input.operationId}.json`, proposed = { schemaVersion: 1, input, nonce: randomUUID() }, intent = Buffer.from(JSON.stringify(proposed));
      let created: "created" | "exists";
      try { created = await this.deps.remote.create(intentKey, intent, "application/json", signal); }
      catch { throw Error("PDF.INTENT_UNKNOWN"); }
      if (created !== "created") throw Error("PDF.EXECUTION_UNKNOWN");
      const saved = await this.deps.remote.read(intentKey, 65536, signal);
      if (!saved || sha256(saved) !== sha256(intent)) throw Error("PDF.INTENT_UNKNOWN");
      // Require source already durable; resolving local bytes alone cannot prove cross-node handoff.
      const source = await this.deps.remote.read(input.pdf.objectKey, input.pdf.byteSize, signal);
      if (!source) throw Error("PDF.NOT_DURABLE");
      verifyBytes(input.pdf, source, policy.maxInputBytes);
      computed = await this.engine.run(input, source, signal, async id => {
        attemptId = id;
        const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, input, attemptId: id })), localKey = pdfAttemptKey(input);
        const state = await this.deps.journal.create(localKey, bytes, "application/json", signal);
        if (state !== "created") throw Error("PDF.EXECUTION_UNKNOWN");
        const verified = await this.deps.journal.read(localKey, 65536, signal);
        if (!verified || sha256(verified) !== sha256(bytes)) throw Error("PDF.ATTEMPT_UNVERIFIED");
      });
      const record = PdfCompletionSchema.parse({ schemaVersion: 1, codec: "pdf-completion/1", input, manifest: computed.manifest, artifact: computed.artifact });
      if (!equal(computed.input, input)) throw Error("PDF.RESULT_INTEGRITY");
      validateOutput(record, computed.bytes);
      const retained = Buffer.from(JSON.stringify(record));
      if (retained.length > 65536) throw Error("PDF.OUTPUT_LIMIT");
      await this.deps.journal.create(key, retained, "application/json", AbortSignal.timeout(10000));
      const local = await this.deps.journal.read(key, 65536, AbortSignal.timeout(10000));
      if (!local || sha256(local) !== sha256(retained)) throw Error("PDF.RESULT_INTEGRITY");
      await new ArtifactResolver(this.deps.copies, this.deps.remote).publish(record.artifact, observationIdentity(input), computed.bytes, signal);
      try { await this.deps.remote.create(key, retained, "application/json", signal); } catch { /* Reconcile by GET, no second PUT. */ }
      const durable = await this.inspect(input, signal); if (!durable) throw Error("PDF.NOT_DURABLE");
      return receipt(durable);
    } catch (error) {
      try { const durable = await this.inspect(input, AbortSignal.timeout(10000)); if (durable) return receipt(durable); } catch { /* Preserve unknown. */ }
      return savePdfReview(this.deps, input, error, computed, attemptId);
    }
  }
}
export async function savePdfReview(deps: PdfEvidenceDependencies, input: PdfInput, error: unknown, computed: PdfPrepared | null = null, attemptId: string | null = null,
  preparation?: { stage: "pdf.text-input"; plan: unknown }): Promise<Extract<PdfActivityOutcome,{status:"review"}>> {
    const raw = error instanceof Error ? ("code" in error ? String(error.code) : error.message) : "";
    const code = /^(PDF|ARTIFACT)\.[A-Z_]+$/.test(raw) ? raw : "PDF.UNRESOLVED", reviewId = `pdf-${randomUUID()}`, key = `pdf-reviews/${reviewId}.json`;
    const record = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId, occurredAt: new Date().toISOString(), observation: observationIdentity(input),
      failure: { schemaVersion: 1, requestId: input.requestId, observationId: input.observationId, operationId: input.operationId,
        inputFingerprint: input.inputFingerprint, stage: preparation?.stage ?? input.module, category: "ARTIFACT", code, executionFact: "unknown", evidenceKey: key, blockedBy: null, automaticRetry: false },
      rawError: { name: "PdfFailure", message: code, stack: null, details: { input, attemptId, ...(preparation ? { plan: preparation.plan } : {}) } },
      candidate: computed ? { schema: "pdf-completion/1", value: { input, manifest: computed.manifest, artifact: computed.artifact, attemptId: computed.attemptId } } : null,
      inspection: { kind: "none" } });
    const bytes = Buffer.from(JSON.stringify(record)), signal = AbortSignal.timeout(10000);
    await deps.journal.create(key, bytes, "application/json", signal);
    const saved = await deps.journal.read(key, 2 * 1024 * 1024, signal);
    if (!saved || sha256(saved) !== sha256(bytes)) throw Error("PDF.REVIEW_UNVERIFIED");
    try { await deps.reviews.append(record); } catch { /* Same ID readback only. */ }
    const confirmed = await deps.reviews.read(reviewId);
    if (!confirmed || !equal(ReviewRecordSchema.parse(confirmed), record)) throw Error("PDF.REVIEW_UNVERIFIED");
    return { status: "review", operationId: input.operationId, code, reviewId, evidenceKey: key, automaticRetry: false };
}
