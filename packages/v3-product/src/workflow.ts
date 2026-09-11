import { condition, defineSignal, defineQuery, setHandler, proxyActivities, isCancellation } from "@temporalio/workflow";
import { z } from "zod";
export { PreparedTextWorkflow } from "./text-workflow.js";
export { PageTextWorkflow } from "./page-workflow.js";
export { PdfTextWorkflow } from "./pdf-text-workflow.js";
export { MixedProductWorkflow } from "./mixed-workflow.js";
export { SavedProductWorkflow } from "./saved-workflow.js";
export { LabelProductWorkflow, finishLabelProduct } from "./label-workflow.js";
import { ProductImageWorkflowInputSchema, ProductImageOutcomeSchema, ProductWorkflowOutcomeSchema, OcrRegistrationSchema, KeywordReceiptSchema, ExecutionIdSchema, observationIdentity,
  ocrActivityOptions, OcrReceiptOutcomeSchema, OcrActivityOutcomeSchema, type OcrInput, type OcrActivityOutcome, type OcrReceiptInput,
  FileAcquireOutcomeSchema, ImageOcrPrepareOutcomeSchema, type FileAcquireInput, type FileAcquireOutcome, type ImageOcrPrepareInput,
  PdfActivityOutcomeSchema, PdfOcrPrepareOutcomeSchema, PdfPagesPrepareOutcomeSchema, ProductPdfWorkflowInputSchema,
  type PdfInput, type PdfActivityOutcome, type PdfOcrPrepareInput, type PdfPagesPrepareInput,
  imageActivityOptions, type OcrRegistration, type ProductImageState, type ProductImageJoin, type ProductImageOutcome, type VisionTask, type ProductCollectionInput, type ProductWorkflowOutcome } from "@crawl-automation/v3-contracts";
export { ProductImageWorkflowInputSchema } from "@crawl-automation/v3-contracts";
export const productOcrReady = defineSignal<[OcrRegistration]>("productOcrReady");
export const productOcrFailed = defineSignal<[{ imageId: string; code: string; reviewId: string }]>("productOcrFailed");
export const productImageProgress = defineQuery<{ expected: number; received: number; finished: number }>("productImageProgress");

/** Closed image manifest, streaming registered OCR receipts. No polling DB and no waiting Activity slots. */
export async function ProductImageWorkflow(raw: unknown): Promise<ProductWorkflowOutcome> {
  const input = ProductImageWorkflowInputSchema.parse(raw), registrations = new Map<string, OcrRegistration>();
  const owned = input.ocrTasks !== undefined || input.fileTasks !== undefined || input.pdfTasks !== undefined;
  const failures = new Map<string, { imageId: string; code: string; reviewId: string }>();
  let conflict = false, finished = 0;
  const accept = (raw: unknown) => {
    try {
      const r = OcrRegistrationSchema.parse(raw), id = r.input.file.artifactId;
      if (JSON.stringify(observationIdentity(r.input)) !== JSON.stringify(input.manifest.observation) || !input.manifest.imageIds.includes(id)) throw Error();
      if (failures.has(id)) throw Error();
      const prior = registrations.get(id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(r)) throw Error();
      registrations.set(id, r);
    } catch { conflict = true; }
  };
  // An owned OCR operation cannot be completed by an unrelated external Signal.
  setHandler(productOcrReady, raw => { if (!owned) accept(raw); });
  setHandler(productOcrFailed, raw => {
    if (owned) return;
    try {
      const f = z.strictObject({ imageId: z.string(), code: z.string().regex(/^[A-Z][A-Z_]*\.[A-Z][A-Z_]*$/), reviewId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/) }).parse(raw);
      if (!input.manifest.imageIds.includes(f.imageId) || registrations.has(f.imageId) ||
        (failures.has(f.imageId) && JSON.stringify(failures.get(f.imageId)) !== JSON.stringify(f))) throw Error();
      failures.set(f.imageId, f);
    } catch { conflict = true; }
  });
  setHandler(productImageProgress, () => ({ expected: input.manifest.imageIds.length, received: registrations.size, finished }));
  input.initialOcr.forEach(accept);
  const screen = proxyActivities<{ screenImageKeywords(raw: OcrRegistration): Promise<unknown> }>(imageActivityOptions(input.queues.keywords));
  const vision = proxyActivities<{ interpretImage(task: VisionTask): Promise<unknown> }>(imageActivityOptions(input.queues.vision));
  const assembly = proxyActivities<{ assembleProductImages(input: ProductImageJoin): Promise<ProductImageOutcome> }>(imageActivityOptions(input.queues.assembly));
  const collection = proxyActivities<{ collectProduct(input: ProductCollectionInput): Promise<ProductWorkflowOutcome> }>(imageActivityOptions(input.queues.collection));
  const ocr = !owned ? null : proxyActivities<{ ocrFile(input: OcrInput): Promise<OcrActivityOutcome> }>(ocrActivityOptions(input.queues.ocr!));
  const receipts = !owned ? null : proxyActivities<{ resolveOcrReceipt(input: OcrReceiptInput): Promise<unknown> }>(imageActivityOptions(input.queues.receipts!));
  const acquire = input.fileTasks === undefined ? null : proxyActivities<{ acquireSourceFile(input: FileAcquireInput): Promise<FileAcquireOutcome> }>(imageActivityOptions(input.queues.acquire!));
  const prepare = input.fileTasks === undefined ? null : proxyActivities<{ prepareImageOcr(input: ImageOcrPrepareInput): Promise<unknown> }>(imageActivityOptions(input.queues.prepare!));
  const render = input.pdfTasks === undefined ? null : proxyActivities<{ renderPdfPage(input: PdfInput): Promise<unknown> }>(imageActivityOptions(input.queues.pdfRender!));
  const pdfPrepare = input.pdfTasks === undefined ? null : proxyActivities<{ preparePdfOcr(input: PdfOcrPrepareInput): Promise<unknown> }>(imageActivityOptions(input.queues.pdfPrepare!));
  const failed = (imageId: string, code: string, reviewId: string | null = null): ProductImageState => ({ status: "review", imageId, code, reviewId });
  const review = z.object({ status: z.literal("review"), code: z.string().regex(/^[A-Z][A-Z_]*\.[A-Z][A-Z_]*$/), reviewId: ExecutionIdSchema });
  const results = await Promise.all(input.manifest.imageIds.map(async (imageId, index): Promise<ProductImageState> => {
    try {
      if (owned) {
        let task = input.ocrTasks?.find(t => t.file.artifactId === imageId);
        if (input.pdfTasks !== undefined) {
          const plan = input.pdfTasks.find(p => p.imageId === imageId)!;
          let receipt: PdfActivityOutcome | null = null;
          try { receipt = PdfActivityOutcomeSchema.parse(await render!.renderPdfPage(plan.render)); }
          catch (error) { if (isCancellation(error)) throw error; /* Read-only evidence reconciliation, not a second render. */ }
          const prepared = PdfOcrPrepareOutcomeSchema.parse(await pdfPrepare!.preparePdfOcr({ plan, receipt }));
          if (prepared.status === "review") {
            if (prepared.operationId !== plan.render.operationId) return failed(imageId, "PDF.IDENTITY_CONFLICT");
            return failed(imageId, prepared.code, prepared.reviewId);
          }
          task = prepared.task;
          if (task.file.kind !== "pdf-page" || task.file.parentArtifactId !== plan.render.pdf.artifactId ||
            plan.render.module !== "pdf.render" || task.file.pageIndex !== plan.render.pageIndex || task.operationId !== plan.ocrOperationId ||
            task.file.artifactId !== imageId || task.file.producer.operationId !== plan.render.operationId || task.file.producer.module !== "pdf.render" ||
            JSON.stringify(observationIdentity(task)) !== JSON.stringify(input.manifest.observation) || Object.entries(plan.ocr).some(([k,v]) => task![k as keyof OcrInput] !== v))
            return failed(imageId, "PDF.IDENTITY_CONFLICT");
        }
        if (input.fileTasks !== undefined) {
          const plan = input.fileTasks.find(t => t.imageId === imageId)!;
          let receipt: FileAcquireOutcome | null = null;
          try { receipt = FileAcquireOutcomeSchema.parse(await acquire!.acquireSourceFile(plan.acquire)); }
          catch (error) { if (isCancellation(error)) throw error; /* Resolve completion only; never download twice. */ }
          const prepared = ImageOcrPrepareOutcomeSchema.parse(await prepare!.prepareImageOcr({ plan, receipt }));
          if (prepared.status === "review") {
            if (prepared.operationId !== plan.acquire.operationId) return failed(imageId, "IMAGE.IDENTITY_CONFLICT");
            return failed(imageId, prepared.code, prepared.reviewId);
          }
          task = prepared.task;
          if (task.operationId !== plan.ocrOperationId || task.file.artifactId !== imageId || task.file.producer.operationId !== plan.acquire.operationId ||
            task.file.producer.module !== "file.acquire" || task.file.kind !== "source-image" || JSON.stringify(observationIdentity(task)) !== JSON.stringify(input.manifest.observation) ||
            Object.entries(plan.ocr).some(([k, v]) => task![k as keyof OcrInput] !== v)) return failed(imageId, "IMAGE.IDENTITY_CONFLICT");
        }
        if (!task) return failed(imageId, "IMAGE.IDENTITY_CONFLICT");
        let outcome: OcrActivityOutcome | null = null;
        try { outcome = OcrActivityOutcomeSchema.parse(await ocr!.ocrFile(task)); }
        catch (error) { if (isCancellation(error)) throw error; /* Failure/timeout: evidence reconciliation only, no second OCR. */ }
        const receipt = OcrReceiptOutcomeSchema.parse(await receipts!.resolveOcrReceipt({ input: task, outcome }));
        if (receipt.status === "review") {
          if (receipt.operationId !== task.operationId || receipt.imageId !== imageId) return failed(imageId, "RECEIPT.IDENTITY_CONFLICT");
          return failed(imageId, receipt.code, receipt.reviewId);
        }
        if (JSON.stringify(receipt.registration.input) !== JSON.stringify(task)) return failed(imageId, "RECEIPT.IDENTITY_CONFLICT");
        accept(receipt.registration);
      }
      const available = owned || await condition(() => conflict || registrations.has(imageId) || failures.has(imageId), input.ocrWaitMs);
      if (conflict) return failed(imageId, "PRODUCT.IDENTITY_CONFLICT");
      if (!available) return failed(imageId, "SCREEN.OCR_NOT_READY");
      const upstreamFailure = failures.get(imageId);
      if (upstreamFailure) return failed(imageId, upstreamFailure.code, upstreamFailure.reviewId);
      const registration = registrations.get(imageId)!, rawKeyword = await screen.screenImageKeywords(registration);
      const screenReview = review.safeParse(rawKeyword);
      if (screenReview.success) return failed(imageId, screenReview.data.code, screenReview.data.reviewId);
      const keyword = KeywordReceiptSchema.parse(rawKeyword);
      if (keyword.imageId !== imageId || JSON.stringify(keyword.selection.observation) !== JSON.stringify(input.manifest.observation) ||
        JSON.stringify(keyword.selection.image) !== JSON.stringify(registration.input.file) || keyword.selection.ocrOperationId !== registration.input.operationId)
        return failed(imageId, "PRODUCT.IDENTITY_CONFLICT");
      if (keyword.status === "not_matched") return { status: "not_matched", imageId, keyword };
      const task: VisionTask = { input: { operationId: `${input.manifest.operationId}-image-${index}`, selection: keyword.selection },
        configFingerprint: input.manifest.configFingerprint };
      const rawVision = await vision.interpretImage(task), visionReview = review.safeParse(rawVision);
      if (visionReview.success) return failed(imageId, visionReview.data.code, visionReview.data.reviewId);
      const receipt = z.object({ status: z.literal("registered"), operationId: z.literal(task.input.operationId) }).safeParse(rawVision);
      if (!receipt.success) return failed(imageId, "VISION.RECEIPT_INVALID");
      return { status: "registered", imageId, keyword, task };
    } catch (error) { if (isCancellation(error)) throw error; return failed(imageId, "PRODUCT.STAGE_UNRESOLVED"); }
    finally { finished++; }
  }));
  // A conflicting duplicate receipt is never allowed to overwrite an accepted source.
  const images = conflict ? results.map(r => failed(r.imageId, "PRODUCT.IDENTITY_CONFLICT")) : results;
  const join = { manifest: input.manifest, images }, assembled = ProductImageOutcomeSchema.parse(await assembly.assembleProductImages(join));
  if (assembled.status === "review") return assembled;
  return ProductWorkflowOutcomeSchema.parse(await collection.collectProduct({ join, evidenceKey: assembled.evidenceKey }));
}

/** PDF planning precedes the closed page manifest; each page then streams through the same product workflow. */
export async function ProductPdfWorkflow(raw: unknown): Promise<ProductWorkflowOutcome> {
  const input = ProductPdfWorkflowInputSchema.parse(raw);
  const inspect = proxyActivities<{ inspectPdf(input: PdfInput): Promise<unknown> }>(imageActivityOptions(input.queues.inspection));
  const prepare = proxyActivities<{ preparePdfPages(input: PdfPagesPrepareInput): Promise<unknown> }>(imageActivityOptions(input.queues.pages));
  let receipt: PdfActivityOutcome | null = null;
  try { receipt = PdfActivityOutcomeSchema.parse(await inspect.inspectPdf(input.plan.inspection)); }
  catch (error) { if (isCancellation(error)) throw error; }
  const planned = PdfPagesPrepareOutcomeSchema.parse(await prepare.preparePdfPages({ plan: input.plan, receipt }));
  if (planned.status === "review") {
    if (planned.operationId !== input.plan.inspection.operationId) throw Error("PDF.IDENTITY_CONFLICT");
    return { status: "review", codes: [planned.code], reviewId: planned.reviewId, evidenceKey: planned.evidenceKey, automaticRetry: false };
  }
  for (const [pageIndex, p] of planned.pages.entries()) {
    if (p.render.module !== "pdf.render" || p.render.pageIndex !== pageIndex || p.render.scale !== input.plan.scale ||
      p.render.operationId !== `${input.plan.operationId}-render-${pageIndex}` || p.ocrOperationId !== `${input.plan.operationId}-ocr-${pageIndex}` ||
      JSON.stringify(p.render.pdf) !== JSON.stringify(input.plan.inspection.pdf) || JSON.stringify(p.ocr) !== JSON.stringify(input.plan.ocr) ||
      JSON.stringify(observationIdentity(p.render)) !== JSON.stringify(observationIdentity(input.plan.inspection))) throw Error("PDF.IDENTITY_CONFLICT");
  }
  const { inspection: _inspection, pages: _pages, ...queues } = input.queues;
  return ProductImageWorkflow({ manifest: { operationId: input.plan.operationId, observation: observationIdentity(input.plan.inspection),
    imageIds: planned.pages.map(p => p.imageId), configFingerprint: input.plan.configFingerprint }, pdfTasks: planned.pages, queues });
}
export { GncPreparedLabelWorkflow } from "./gnc-label-workflow.js";
export { GncStreamingLabelWorkflow } from "./gnc-stream-workflow.js";
export { LabelCoreWorkflow } from "./label-core-workflow.js";
