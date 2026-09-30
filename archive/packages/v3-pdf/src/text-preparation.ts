import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { PdfTextPrepareInputSchema, PdfTextPlanSchema, PdfDataSchema, ReviewRecordSchema, TextDocumentSchema, TextInputSchema,
  observationIdentity, textFingerprint, type ArtifactRef, type PdfTextPlan } from "@crawl-automation/v3-contracts";
import { sha256, verifyBytes, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { PdfEvidence, pdfCompletionKey, savePdfReview, type PdfEvidenceDependencies } from "./handoff.js";
import { inputChecked } from "./runtime.js";
const hash = (v: string | Uint8Array) => sha256(typeof v === "string" ? Buffer.from(v) : v);
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
export const pdfTextInputKey = (p: PdfTextPlan) => `v3/pdf-text-inputs/${p.textOperationId}/input.json`;

/** Read-only reconstruction of the exact expected task. No publishing, review writes or engine port. */
export class PdfTextEvidence {
  constructor(private readonly remote: Pick<ObjectStore, "read">, private readonly evidence: Pick<PdfEvidence, "inspect">) {}
  async candidate(raw: unknown, signal: AbortSignal) {
    const plan = PdfTextPlanSchema.parse(raw), input = plan.extraction;
    if (input.module !== "pdf.text") throw Error("PDF.IDENTITY_CONFLICT");
    const record = await this.evidence.inspect(input, signal);
    if (!record) throw Error("PDF.NOT_DURABLE");
    const bytes = await this.remote.read(record.artifact.objectKey, record.artifact.byteSize, signal);
    if (!bytes) throw Error("PDF.NOT_DURABLE");
    verifyBytes(record.artifact, bytes, 32 * 1024 * 1024);
    const data = PdfDataSchema.parse(decode(bytes));
    if (data.kind !== "text" || data.pageIndex !== input.pageIndex) throw Error("PDF.RESULT_INTEGRITY");
    if (!data.hasText || !data.text.trim()) throw Error("PDF.TEXT_EMPTY");
    if (data.text.length > 200000) throw Error("PDF.TEXT_LIMIT");
    const document = TextDocumentSchema.parse({ ...observationIdentity(input), producer: "pdf.text", source: input.pdf, pageIndex: input.pageIndex, text: data.text });
    const encoded = Buffer.from(JSON.stringify(document));
    const ref: ArtifactRef = { schemaVersion: 1, artifactId: `pdf-text-document-${hash(input.operationId)}`,
      observationId: input.observationId, sourceId: input.sourceId, listingId: input.listingId, variantId: input.variantId,
      kind: "result-json", mediaType: "application/json", byteSize: encoded.length, sha256: hash(encoded),
      objectKey: `v3/pdf-text-documents/${input.operationId}/document.json`, producer: record.artifact.producer };
    const unsigned = { ...observationIdentity(input), ...plan.text, operationId: plan.textOperationId,
      source: { kind: "prepared" as const, document: ref }, range: { start: 0, end: data.text.length } };
    const task = TextInputSchema.parse({ ...unsigned, inputFingerprint: textFingerprint(unsigned, hash) });
    return { plan, record, encoded, ref, task };
  }
  async inspect(plan: PdfTextPlan, signal: AbortSignal) {
    const expected = await this.candidate(plan, signal), { record, ref, task } = expected;
    const document = await this.remote.read(ref.objectKey, 2 * 1024 * 1024, signal);
    if (!document) throw Error("PDF.NOT_DURABLE");
    verifyBytes(ref, document, 2 * 1024 * 1024);
    const input = await this.remote.read(pdfTextInputKey(plan), 65536, signal);
    if (!input || !equal(decode(input), { schemaVersion: 1, plan: expected.plan, extraction: record, task })) throw Error("PDF.TEXT_INPUT_UNVERIFIED");
    return task;
  }
}

/** No subprocess/model/OCR port. Converts verified PDF output to a provenance-preserving text document. */
export class PdfTextPreparation {
  private readonly evidence: PdfEvidence;
  constructor(private readonly deps: PdfEvidenceDependencies) { this.evidence = new PdfEvidence(deps); }
  private async publish(key: string, bytes: Uint8Array, signal: AbortSignal) {
    const verify = (b: Uint8Array | null) => { if (!b || hash(b) !== hash(bytes)) throw Error("PDF.HANDOFF_UNVERIFIED"); };
    const existing = await this.deps.remote.read(key, 2 * 1024 * 1024, signal);
    if (existing) { verify(existing); return; }
    // Retain candidate first; shared one-shot intent also protects empty-cache replacements.
    await this.deps.journal.create(key, bytes, "application/json", signal);
    verify(await this.deps.journal.read(key, 2 * 1024 * 1024, signal));
    const intentKey = `pdf-text-publications/${hash(key)}.json`, marker = Buffer.from(JSON.stringify({ key, sha256: hash(bytes), nonce: randomUUID() }));
    if (await this.deps.journal.create(intentKey, marker, "application/json", signal) !== "created") throw Error("PDF.HANDOFF_PENDING");
    const local = await this.deps.journal.read(intentKey, 65536, signal);
    if (!local || hash(local) !== hash(marker)) throw Error("PDF.HANDOFF_PENDING");
    let claim;
    try { claim = await this.deps.remote.create(intentKey, marker, "application/json", signal); }
    catch { throw Error("PDF.HANDOFF_PENDING"); }
    if (claim !== "created") throw Error("PDF.HANDOFF_PENDING");
    const shared = await this.deps.remote.read(intentKey, 65536, signal);
    if (!shared || hash(shared) !== hash(marker)) throw Error("PDF.HANDOFF_PENDING");
    try { await this.deps.remote.create(key, bytes, "application/json", signal); } catch { /* Read only; no second PUT. */ }
    verify(await this.deps.remote.read(key, 2 * 1024 * 1024, signal));
  }
  async run(raw: unknown, signal: AbortSignal) {
    const { plan, receipt } = PdfTextPrepareInputSchema.parse(raw), input = plan.extraction;
    try {
      inputChecked(input); signal.throwIfAborted();
      if (input.module !== "pdf.text") throw Error("PDF.IDENTITY_CONFLICT");
      if (receipt?.operationId && receipt.operationId !== input.operationId) throw Error("PDF.IDENTITY_CONFLICT");
      if (receipt?.status === "review") {
        const rawReview = await this.deps.reviews.read(receipt.reviewId);
        if (!rawReview) throw Error("PDF.REVIEW_UNVERIFIED");
        const r = ReviewRecordSchema.parse(rawReview);
        if (r.reviewId !== receipt.reviewId || r.failure.operationId !== input.operationId || r.failure.inputFingerprint !== input.inputFingerprint ||
          r.failure.stage !== "pdf.text" || r.failure.code !== receipt.code || r.failure.evidenceKey !== receipt.evidenceKey ||
          !equal(r.observation, observationIdentity(input))) throw Error("PDF.IDENTITY_CONFLICT");
        return receipt;
      }
      const { record, encoded, ref, task } = await new PdfTextEvidence(this.deps.remote, this.evidence).candidate(plan, signal);
      if (receipt && (receipt.evidenceKey !== pdfCompletionKey(input) || !equal(receipt.artifact, record.artifact))) throw Error("PDF.IDENTITY_CONFLICT");
      await this.publish(ref.objectKey, encoded, signal);
      const evidenceKey = pdfTextInputKey(plan), candidate = Buffer.from(JSON.stringify({ schemaVersion: 1, plan, extraction: record, task }));
      await this.publish(evidenceKey, candidate, signal);
      return { status: "prepared" as const, task, evidenceKey };
    } catch (error) { return savePdfReview(this.deps, input, error, null, null, { stage: "pdf.text-input", plan }); }
  }
}
