import { isDeepStrictEqual as equal } from "node:util";
import { PdfPagesPrepareInputSchema, PdfOcrPrepareInputSchema, PdfPageOcrPlanSchema, PdfDataSchema, ReviewRecordSchema, OcrInputSchema,
  observationIdentity, fingerprintOcrInput, type PdfInput, type PdfActivityOutcome } from "@crawl-automation/v3-contracts";
import { sha256, verifyBytes } from "@crawl-automation/v3-artifacts";
import { inputChecked, fingerprintPdfInput } from "./runtime.js";
import { PdfEvidence, pdfCompletionKey, savePdfReview, type PdfEvidenceDependencies } from "./handoff.js";

/** Has no Python, OCR, Codex, downloader or Temporal client capability. */
export class PdfPreparation {
  private readonly evidence: PdfEvidence;
  constructor(private readonly deps: PdfEvidenceDependencies) { this.evidence = new PdfEvidence(deps); }
  private async resolve(input: PdfInput, receipt: PdfActivityOutcome | null, signal: AbortSignal) {
    inputChecked(input);
    if (receipt && receipt.operationId !== input.operationId) throw Error("PDF.IDENTITY_CONFLICT");
    if (receipt?.status === "review") {
      const raw = await this.deps.reviews.read(receipt.reviewId);
      if (!raw) throw Error("PDF.REVIEW_UNVERIFIED");
      const stored = ReviewRecordSchema.parse(raw);
      if (stored.reviewId !== receipt.reviewId || stored.failure.code !== receipt.code || stored.failure.evidenceKey !== receipt.evidenceKey ||
        stored.failure.operationId !== input.operationId || stored.failure.inputFingerprint !== input.inputFingerprint || stored.failure.stage !== input.module ||
        !equal(stored.observation, observationIdentity(input))) throw Error("PDF.IDENTITY_CONFLICT");
      return receipt;
    }
    const record = await this.evidence.inspect(input, signal);
    if (!record) throw Error("PDF.NOT_DURABLE");
    if (receipt && (receipt.evidenceKey !== pdfCompletionKey(input) || !equal(receipt.artifact, record.artifact))) throw Error("PDF.IDENTITY_CONFLICT");
    return record;
  }
  private async publish(key: string, value: unknown, signal: AbortSignal) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 4 * 1024 * 1024) throw Error("PDF.OUTPUT_LIMIT");
    const verify = (actual: Uint8Array | null) => { if (!actual || sha256(actual) !== sha256(bytes)) throw Error("PDF.PLAN_CONFLICT"); };
    const prior = await this.deps.remote.read(key, 4 * 1024 * 1024, signal);
    if (prior) { verify(prior); return; }
    if (await this.deps.journal.read(key, 4 * 1024 * 1024, signal)) throw Error("PDF.HANDOFF_PENDING");
    await this.deps.journal.create(key, bytes, "application/json", signal);
    verify(await this.deps.journal.read(key, 4 * 1024 * 1024, signal));
    try { await this.deps.remote.create(key, bytes, "application/json", signal); } catch { /* GET only. */ }
    verify(await this.deps.remote.read(key, 4 * 1024 * 1024, signal));
  }
  async pages(raw: unknown, signal: AbortSignal) {
    const { plan, receipt } = PdfPagesPrepareInputSchema.parse(raw), input = plan.inspection;
    try {
      const record = await this.resolve(input, receipt, signal);
      if ("status" in record) return record;
      const bytes = await this.deps.remote.read(record.artifact.objectKey, record.artifact.byteSize, signal);
      if (!bytes) throw Error("PDF.NOT_DURABLE");
      verifyBytes(record.artifact, bytes, 32 * 1024 * 1024);
      const data = PdfDataSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      if (data.kind !== "inspect" || data.pages.length !== data.pageCount || data.pages.some((p, n) => p.pageIndex !== n)) throw Error("PDF.RESULT_INTEGRITY");
      if (data.pageCount > 100) throw Error("PDF.PRODUCT_PAGE_LIMIT");
      const pages = data.pages.map(({ pageIndex }) => {
        const render: PdfInput = { ...input, module: "pdf.render", operationId: `${plan.operationId}-render-${pageIndex}`, pageIndex, scale: plan.scale };
        render.inputFingerprint = fingerprintPdfInput(render);
        return PdfPageOcrPlanSchema.parse({ imageId: `pdf-${render.inputFingerprint}`, render, ocrOperationId: `${plan.operationId}-ocr-${pageIndex}`, ocr: plan.ocr });
      });
      if (input.operationId === plan.operationId || pages.some(p => p.render.operationId === input.operationId || p.ocrOperationId === input.operationId)) throw Error("PDF.IDENTITY_CONFLICT");
      const key = `v3/pdf-preparation/${plan.operationId}/pages.json`;
      await this.publish(key, { schemaVersion: 1, plan, inspection: record, pages }, signal);
      return { status: "planned" as const, pages, evidenceKey: key };
    } catch (error) { return savePdfReview(this.deps, input, error); }
  }
  async ocr(raw: unknown, signal: AbortSignal) {
    const { plan, receipt } = PdfOcrPrepareInputSchema.parse(raw), input = plan.render;
    try {
      const record = await this.resolve(input, receipt, signal);
      if ("status" in record) return record;
      if (record.artifact.kind !== "pdf-page" || record.artifact.artifactId !== plan.imageId) throw Error("PDF.IDENTITY_CONFLICT");
      const unsigned = { ...observationIdentity(input), ...plan.ocr, operationId: plan.ocrOperationId, file: record.artifact };
      const task = OcrInputSchema.parse({ ...unsigned, inputFingerprint: fingerprintOcrInput(unsigned, s => sha256(Buffer.from(s))) });
      const key = `v3/pdf-preparation/${plan.ocrOperationId}/input.json`;
      await this.publish(key, { schemaVersion: 1, plan, render: record, task }, signal);
      return { status: "prepared" as const, task, evidenceKey: key };
    } catch (error) { return savePdfReview(this.deps, input, error); }
  }
}
