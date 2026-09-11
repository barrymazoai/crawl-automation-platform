import { isDeepStrictEqual as equal } from "node:util";
import { KeywordResultSchema, ReviewRecordSchema, TextInputSchema, OcrInputSchema, fingerprintOcrInput, observationIdentity, textFingerprint,
  type SavedEvidenceSource, type ProductResolvedEvidenceSource, type ProductEvidenceJoin, type PreparedPageRecord,
  type PagePrepareInput, type OcrRegistration, type KeywordResult, type ReviewRecord, type PdfTextPlan, type TextInput, type FileAcquireInput, type AcquiredFileRecord } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { digest, keywordKey, keywordCompatibility, visionFingerprint } from "@crawl-automation/v3-vision";
export type SavedResolution = { status: "resolved"; source: ProductResolvedEvidenceSource } | { status: "not_matched" } | { status: "review"; code: string };
/** Read-only adapter from saved source plans to already produced task evidence. Never prepares or executes. */
export class SavedSourceEvidence {
  constructor(private readonly deps: { remote: ObjectStore;
    files?: { inspect(input: FileAcquireInput, signal: AbortSignal): Promise<AcquiredFileRecord | null> };
    pdfText?: { inspect(plan: PdfTextPlan, signal: AbortSignal): Promise<TextInput> };
    pages: { inspect(input: PagePrepareInput, signal: AbortSignal): Promise<PreparedPageRecord | null> };
    ocr: { read(id: string): Promise<OcrRegistration | null> };
    screen: { screen(record: OcrRegistration, signal: AbortSignal): Promise<KeywordResult> };
    reviews: { read(id: string): Promise<ReviewRecord | null> } }) {}
  private async pdf(source: Extract<SavedEvidenceSource, { kind: "pdf-text" }>, signal: AbortSignal) {
    if (!this.deps.pdfText) throw Error("SAVED.PDF_ADAPTER_REQUIRED");
    return { id: source.id, required: source.required, kind: "text" as const, task: await this.deps.pdfText.inspect(source.plan, signal) };
  }
  private async page(source: Extract<SavedEvidenceSource, { kind: "page" }>, signal: AbortSignal) {
    const record = await this.deps.pages.inspect(source.plan.page, signal); if (!record) throw Error("SAVED.PAGE_UNCONFIRMED");
    const unsigned = { ...observationIdentity(source.plan.page), ...source.plan.text, operationId: source.plan.textOperationId,
      source: { kind: "prepared" as const, document: record.document }, range: { start: 0, end: record.textLength } };
    const task = TextInputSchema.parse({ ...unsigned, inputFingerprint: textFingerprint(unsigned, digest) });
    const bytes = await this.deps.remote.read(`v3/page-text-inputs/${source.plan.textOperationId}.json`, 65536, signal);
    if (!bytes || !equal(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), { plan: source.plan, record, task }))
      throw Error("SAVED.PAGE_INPUT_UNCONFIRMED");
    return { id: source.id, required: source.required, kind: "text" as const, task };
  }
  private async registration(source: Extract<SavedEvidenceSource, { kind: "ocr-image" }>) {
    const record = await this.deps.ocr.read(source.task.operationId);
    if (!record || !equal(record.input, source.task)) throw Error("SAVED.OCR_UNCONFIRMED");
    return record;
  }
  private async image(source: Extract<SavedEvidenceSource, { kind: "ocr-image" }>, signal: AbortSignal) {
    const record = await this.registration(source), selection = await this.deps.screen.screen(record, signal);
    const bytes = await this.deps.remote.read(keywordKey(selection), 1024 * 1024, signal);
    if (!bytes || !equal(KeywordResultSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))), selection))
      throw Error("SAVED.KEYWORDS_UNCONFIRMED");
    return { id: source.id, required: source.required, kind: "image" as const,
      task: { input: { operationId: source.visionOperationId, selection }, configFingerprint: source.configFingerprint } };
  }
  async resolve(source: SavedEvidenceSource, state: ProductEvidenceJoin["states"][number], signal: AbortSignal): Promise<SavedResolution> {
    if (state.status === "rejected") throw Error("SAVED.RECEIPT_INVALID");
    if (source.kind === "file-image") {
      const { plan } = source;
      if (state.status === "review") {
        const raw = await this.deps.reviews.read(state.reviewId);
        if (!raw) throw Error("SAVED.REVIEW_UNVERIFIED");
        const r = ReviewRecordSchema.parse(raw);
        if (["file.acquire", "image.ocr-input"].includes(r.failure.stage)) {
          if (r.reviewId !== state.reviewId || r.failure.operationId !== plan.acquire.operationId || r.failure.inputFingerprint !== plan.acquire.inputFingerprint ||
            !equal(r.observation, observationIdentity(plan.acquire))) throw Error("SAVED.IDENTITY_CONFLICT");
          if (r.failure.stage === "image.ocr-input" && (!r.candidate || typeof r.candidate.value !== "object" || r.candidate.value === null ||
            Array.isArray(r.candidate.value) || !equal(r.candidate.value.plan, plan))) throw Error("SAVED.IDENTITY_CONFLICT");
          return { status: "review", code: r.failure.code };
        }
      }
      try {
        const record = await this.deps.files?.inspect(plan.acquire, signal);
        if (!record || !equal(record.input, plan.acquire) || record.file.kind !== "source-image" || record.file.artifactId !== plan.imageId) throw Error("SAVED.FILE_UNCONFIRMED");
        const unsigned = { ...observationIdentity(plan.acquire), ...plan.ocr, operationId: plan.ocrOperationId, file: record.file };
        const task = OcrInputSchema.parse({ ...unsigned, inputFingerprint: fingerprintOcrInput(unsigned, digest) });
        const bytes = await this.deps.remote.read(`v3/acquisition/${plan.acquire.operationId}/ocr-${plan.ocrOperationId}.json`, 65536, signal);
        if (!bytes || !equal(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), { schemaVersion: 1, codec: "image-ocr-input/1", plan, acquisition: record, task })) throw Error("SAVED.FILE_INPUT_UNCONFIRMED");
        return this.resolve({ id: source.id, required: source.required, kind: "ocr-image", task,
          visionOperationId: source.visionOperationId, configFingerprint: source.configFingerprint }, state, signal);
      } catch (error) { signal.throwIfAborted(); if (state.status === "review") throw error; return { status: "review", code: "SAVED.PREPARATION_UNVERIFIED" }; }
    }
    if (state.status === "review") {
      const raw = await this.deps.reviews.read(state.reviewId); if (!raw) throw Error("SAVED.REVIEW_UNVERIFIED");
      const r = ReviewRecordSchema.parse(raw), owner = source.kind === "pdf-text" ? observationIdentity(source.plan.extraction) : source.kind === "page" ? observationIdentity(source.plan.page) : observationIdentity(source.task);
      if (r.reviewId !== state.reviewId || !equal(r.observation, owner)) throw Error("SAVED.IDENTITY_CONFLICT");
      let op: string, fp: string;
      if (source.kind === "pdf-text") {
        if (["pdf.text", "pdf.text-input"].includes(r.failure.stage)) {
          op = source.plan.extraction.operationId; fp = source.plan.extraction.inputFingerprint;
          const details = r.rawError.details;
          if (r.failure.stage === "pdf.text-input" && (!details || typeof details !== "object" || Array.isArray(details) || !equal(details.plan, source.plan))) throw Error("SAVED.IDENTITY_CONFLICT");
        } else if (["codex.text", "text.receipt"].includes(r.failure.stage)) {
          const resolved = await this.pdf(source, signal); op = resolved.task.operationId; fp = resolved.task.inputFingerprint;
        } else throw Error("SAVED.IDENTITY_CONFLICT");
      } else if (source.kind === "page") {
        if (["page.prepare", "page.text-input"].includes(r.failure.stage)) { op = source.plan.page.operationId; fp = source.plan.page.inputFingerprint; }
        else if (["codex.text", "text.receipt"].includes(r.failure.stage)) { const resolved = await this.page(source, signal); op = resolved.task.operationId; fp = resolved.task.inputFingerprint; }
        else throw Error("SAVED.IDENTITY_CONFLICT");
      } else {
        if (["ocr.file", "ocr.receipt"].includes(r.failure.stage)) { op = source.task.operationId; fp = source.task.inputFingerprint; }
        else if (r.failure.stage === "ocr.keywords") {
          const registration = await this.registration(source);
          op = `screen-${digest(JSON.stringify([source.task.operationId, keywordCompatibility]))}`; fp = digest(JSON.stringify(registration));
        } else if (r.failure.stage === "codex.vision") {
          const resolved = await this.image(source, signal); op = source.visionOperationId; fp = visionFingerprint(resolved.task);
        } else throw Error("SAVED.IDENTITY_CONFLICT");
      }
      if (r.failure.operationId !== op || r.failure.inputFingerprint !== fp) throw Error("SAVED.IDENTITY_CONFLICT");
      return { status: "review", code: r.failure.code };
    }
    // A claimed success is not proof; derive tasks from reverified preparation evidence.
    try {
      if (source.kind === "page" || source.kind === "pdf-text") {
        if (state.status === "not_matched") throw Error("SAVED.RECEIPT_INVALID");
        return { status: "resolved", source: source.kind === "page" ? await this.page(source, signal) : await this.pdf(source, signal) };
      }
      const resolved = await this.image(source, signal);
      if (resolved.task.input.selection.status === "not_matched") {
        if (state.status === "registered") throw Error("SAVED.RECEIPT_INVALID");
        return { status: "not_matched" };
      }
      if (state.status === "not_matched") throw Error("SAVED.RECEIPT_INVALID");
      return { status: "resolved", source: resolved };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message === "SAVED.RECEIPT_INVALID") throw error;
      return { status: "review", code: "SAVED.PREPARATION_UNVERIFIED" };
    }
  }
}
