import { proxyActivities, isCancellation, ApplicationFailure, defineQuery, setHandler } from "@temporalio/workflow";
import { z } from "zod";
import { SavedProductWorkflowInputSchema, PagePrepareOutcomeSchema, PageTextPrepareOutcomeSchema, OcrActivityOutcomeSchema,
  OcrReceiptOutcomeSchema, KeywordReceiptSchema, ExecutionIdSchema, observationIdentity, imageActivityOptions, ocrActivityOptions,
  FileAcquireOutcomeSchema, ImageOcrPrepareOutcomeSchema,
  type FileAcquireInput, type FileAcquireOutcome, type ImageOcrPrepareInput, type SavedEvidenceSource,
  type PagePrepareOutcome, type PagePrepareInput, type PageTextPrepareInput, type OcrInput, type OcrActivityOutcome,
  type OcrReceiptInput, type OcrRegistration, type VisionTask, type ProductEvidenceJoin } from "@crawl-automation/v3-contracts";
import { PreparedTextWorkflow } from "./text-workflow.js";
import { PdfTextWorkflow } from "./pdf-text-workflow.js";
import { finishMixedProduct } from "./mixed-workflow.js";
export const savedProductProgress = defineQuery<{ expected: number; finished: number }>("savedProductProgress");
/** Retained HTML/images/PDF pages. Each source progresses independently before the final join. */
export async function SavedProductWorkflow(raw: unknown) {
  const parsed = SavedProductWorkflowInputSchema.safeParse(raw);
  if (!parsed.success) throw ApplicationFailure.nonRetryable("Invalid saved product sources", "SAVED.INVALID_INPUT");
  const { manifest, queues } = parsed.data;
  let finished = 0; setHandler(savedProductProgress, () => ({ expected: manifest.sources.length, finished }));
  const pages = proxyActivities<{ prepareHtmlPage(input: PagePrepareInput): Promise<unknown> }>(imageActivityOptions(queues.page));
  const pageText = proxyActivities<{ preparePageText(input: PageTextPrepareInput): Promise<unknown> }>(imageActivityOptions(queues.pageText));
  const ocr = proxyActivities<{ ocrFile(input: OcrInput): Promise<unknown> }>(ocrActivityOptions(queues.ocr));
  const receipts = proxyActivities<{ resolveOcrReceipt(input: OcrReceiptInput): Promise<unknown> }>(imageActivityOptions(queues.ocrReceipts));
  const keywords = proxyActivities<{ screenImageKeywords(input: OcrRegistration): Promise<unknown> }>(imageActivityOptions(queues.keywords));
  const vision = proxyActivities<{ interpretImage(input: VisionTask): Promise<unknown> }>(imageActivityOptions(queues.vision));
  const files = queues.acquire ? proxyActivities<{ acquireSourceFile(input: FileAcquireInput): Promise<unknown> }>(imageActivityOptions(queues.acquire)) : null;
  const imagePrepare = queues.imagePrepare ? proxyActivities<{ prepareImageOcr(input: ImageOcrPrepareInput): Promise<unknown> }>(imageActivityOptions(queues.imagePrepare)) : null;
  const review = z.object({ status: z.literal("review"), reviewId: ExecutionIdSchema });
  const states = await Promise.all(manifest.sources.map(async (source): Promise<ProductEvidenceJoin["states"][number]> => {
    const rejected = () => ({ id: source.id, status: "rejected" as const });
    const failed = (reviewId: string) => ({ id: source.id, status: "review" as const, reviewId });
    try {
      if (source.kind === "pdf-text") {
        const result = await PdfTextWorkflow({ plan: source.plan, queues: { extraction: queues.pdfText!, prepare: queues.pdfTextPrepare!,
          text: queues.text, receipts: queues.textReceipts } });
        return result.status === "review" ? failed(result.reviewId) : { id: source.id, status: "registered" };
      }
      if (source.kind === "page") {
        const { plan } = source;
        let receipt: PagePrepareOutcome | null = null;
        try { receipt = PagePrepareOutcomeSchema.parse(await pages.prepareHtmlPage(plan.page)); }
        catch (error) { if (isCancellation(error)) throw error; }
        const decoded = PageTextPrepareOutcomeSchema.safeParse(await pageText.preparePageText({ plan, receipt }));
        if (!decoded.success) return rejected();
        const prepared = decoded.data;
        if (prepared.status === "review") return prepared.operationId === plan.page.operationId ? failed(prepared.reviewId) : rejected();
        const task = prepared.task;
        if (task.operationId !== plan.textOperationId || task.source.kind !== "prepared" || task.range.start !== 0 ||
          task.source.document.producer.module !== "page.prepare" || task.source.document.producer.operationId !== plan.page.operationId ||
          task.source.document.producer.implementationVersion !== plan.page.implementationVersion ||
          JSON.stringify(observationIdentity(task)) !== JSON.stringify(manifest.observation) || Object.entries(plan.text).some(([k,v]) => task[k as keyof typeof task] !== v)) return rejected();
        const result = await PreparedTextWorkflow({ task, queues: { text: queues.text, receipts: queues.textReceipts } });
        return result.status === "review" ? failed(result.reviewId) : { id: source.id, status: "registered" };
      }
      let imageSource: Extract<SavedEvidenceSource, { kind: "ocr-image" }>;
      if (source.kind === "file-image") {
        let fileReceipt: FileAcquireOutcome | null = null;
        try { fileReceipt = FileAcquireOutcomeSchema.parse(await files!.acquireSourceFile(source.plan.acquire)); }
        catch (error) { if (isCancellation(error)) throw error; }
        const prepared = ImageOcrPrepareOutcomeSchema.parse(await imagePrepare!.prepareImageOcr({ plan: source.plan, receipt: fileReceipt }));
        if (prepared.status === "review") return prepared.operationId === source.plan.acquire.operationId ? failed(prepared.reviewId) : rejected();
        const task = prepared.task;
        if (task.operationId !== source.plan.ocrOperationId || task.file.kind !== "source-image" || task.file.artifactId !== source.plan.imageId ||
          task.file.producer.operationId !== source.plan.acquire.operationId || task.file.producer.module !== "file.acquire" ||
          JSON.stringify(observationIdentity(task)) !== JSON.stringify(manifest.observation) || Object.entries(source.plan.ocr).some(([k,v]) => task[k as keyof OcrInput] !== v)) return rejected();
        imageSource = { id: source.id, required: source.required, kind: "ocr-image", task, visionOperationId: source.visionOperationId, configFingerprint: source.configFingerprint };
      } else imageSource = source;
      let outcome: OcrActivityOutcome | null = null;
      try { outcome = OcrActivityOutcomeSchema.parse(await ocr.ocrFile(imageSource.task)); }
      catch (error) { if (isCancellation(error)) throw error; }
      const decoded = OcrReceiptOutcomeSchema.safeParse(await receipts.resolveOcrReceipt({ input: imageSource.task, outcome }));
      if (!decoded.success) return rejected();
      const receipt = decoded.data;
      if (receipt.status === "review") return receipt.operationId === imageSource.task.operationId && receipt.imageId === imageSource.task.file.artifactId ? failed(receipt.reviewId) : rejected();
      if (JSON.stringify(receipt.registration.input) !== JSON.stringify(imageSource.task)) return rejected();
      const rawKeyword = await keywords.screenImageKeywords(receipt.registration), keywordReview = review.safeParse(rawKeyword);
      if (keywordReview.success) return failed(keywordReview.data.reviewId);
      const keyword = KeywordReceiptSchema.safeParse(rawKeyword); if (!keyword.success) return rejected();
      const selection = keyword.data.selection;
      if (selection.ocrOperationId !== imageSource.task.operationId || JSON.stringify(selection.image) !== JSON.stringify(imageSource.task.file) ||
        JSON.stringify(selection.observation) !== JSON.stringify(manifest.observation)) return rejected();
      if (keyword.data.status === "not_matched") return { id: source.id, status: "not_matched" };
      const result = await vision.interpretImage({ input: { operationId: source.visionOperationId, selection }, configFingerprint: source.configFingerprint });
      const failure = review.safeParse(result); if (failure.success) return failed(failure.data.reviewId);
      return z.object({ status: z.literal("registered"), operationId: z.literal(source.visionOperationId) }).safeParse(result).success
        ? { id: source.id, status: "registered" } : rejected();
    } catch (error) {
      if (isCancellation(error)) throw error;
      if (error instanceof ApplicationFailure && ["TEXT_RECEIPT.IDENTITY_CONFLICT", "TEXT_RECEIPT.INVALID_RECEIPT", "PDF.IDENTITY_CONFLICT", "PDF.INVALID_RECEIPT"].includes(error.type ?? "")) return rejected();
      return { id: source.id, status: "unresolved" }; // Final assembly verifies all retained evidence; never schedules another model call.
    } finally { finished++; }
  }));
  return finishMixedProduct({ manifest, states }, queues);
}
