import { proxyActivities, ApplicationFailure, isCancellation, defineQuery, setHandler } from "@temporalio/workflow";
import { GncStreamingLabelWorkflowInputSchema, GncLabelPlanOutcomeSchema, GncLabelSourceOutcomeSchema, GncLabelOutcomeSchema,
  GncAcquireOutcomeSchema, GncProductPrepareOutcomeSchema, PagePrepareOutcomeSchema, PageTextPrepareOutcomeSchema,
  FileAcquireOutcomeSchema, ImageOcrPrepareOutcomeSchema, OcrActivityOutcomeSchema, OcrReceiptOutcomeSchema, KeywordReceiptSchema,
  ExecutionIdSchema, LabelCoreOutcomeSchema, observationIdentity, imageActivityOptions, ocrActivityOptions,
  type LabelProductJoin, type PagePrepareOutcome, type FileAcquireOutcome, type OcrActivityOutcome } from "@crawl-automation/v3-contracts";
import { PreparedTextWorkflow } from "./text-workflow.js";
import { finishLabelProduct } from "./label-workflow.js";
import { resourceGate } from "./resource-workflow.js";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function invalid(message: string): never { throw ApplicationFailure.nonRetryable(message, "GNC.STREAM_IDENTITY_CONFLICT"); }
export const gncStreamProgress = defineQuery<{ expected: number; finished: number }>("gncStreamProgress");
/** One product's closed source list, independent pipelines. No model waits for another source's preparation. */
export async function GncStreamingLabelWorkflow(raw: unknown, sharedGate?:ReturnType<typeof resourceGate>) {
  const parsed = GncStreamingLabelWorkflowInputSchema.safeParse(raw);
  if (!parsed.success) invalid("Invalid GNC streaming input");
  const { input, queues, start } = parsed.data, owner = input.sourcePlan.task.owner;
  const gate = sharedGate??resourceGate(parsed.data.resources);
  let expected = 0, finished = 0; setHandler(gncStreamProgress, () => ({ expected, finished }));
  const activity = (queue: string, name: string, ocr = false) => (raw: unknown) => gate(name, binding => proxyActivities<Record<string, (raw: unknown) => Promise<unknown>>>(
    {...(ocr ? ocrActivityOptions(queue) : imageActivityOptions(queue)),...binding})[name]!(raw));
  if (start === "capture") {
    let receipt = null;
    try { receipt = GncAcquireOutcomeSchema.parse(await activity(queues.capture!, "captureGncProduct")(input.sourcePlan.task)); }
    catch (error) { if (isCancellation(error)) throw error; }
    const captured = GncAcquireOutcomeSchema.safeParse(await activity(queues.captureReceipts!, "resolveGncReceipt")({ task: input.sourcePlan.task, receipt }));
    if (!captured.success || captured.data.operationId !== input.sourcePlan.task.capture.operationId) invalid("Invalid capture receipt");
    if (captured.data.status === "review") return captured.data;
    const planned = GncProductPrepareOutcomeSchema.safeParse(await activity(queues.productPlan!, "prepareGncProduct")({ input: input.sourcePlan, receipt: captured.data }));
    if (!planned.success || planned.data.operationId !== input.sourcePlan.operationId) invalid("Invalid source plan receipt");
    if (planned.data.status === "review") return planned.data;
  }
  // Only capture/plan evidence, not downstream preparation, is read here.
  const loaded = GncLabelPlanOutcomeSchema.safeParse(await activity(queues.plan, "loadGncLabelPlan")(input));
  if (!loaded.success || !same(loaded.data.input, input) || loaded.data.manifest.operationId !== input.sourcePlan.operationId ||
    !same(loaded.data.manifest.observation, owner)) invalid("Invalid GNC source list");
  const manifest = loaded.data.manifest; expected = manifest.sources.length;
  const issued = new Map<string, unknown>();
  const states = await Promise.all(manifest.sources.map(async (source): Promise<LabelProductJoin["states"][number]> => {
    const state = (status: "registered" | "unresolved" | "rejected" | "not_matched") => ({ id: source.id, status });
    const review = (reviewId: string) => ({ id: source.id, status: "review" as const, reviewId });
    let preparedDocument: unknown, preparedRange: unknown, preparedSelection: unknown;
    try {
      if (source.kind === "page") {
        let receipt: PagePrepareOutcome | null = null;
        try { receipt = PagePrepareOutcomeSchema.parse(await activity(queues.page, "prepareHtmlPage")(source.plan.page)); }
        catch (error) { if (isCancellation(error)) throw error; }
        const prepared = PageTextPrepareOutcomeSchema.safeParse(await activity(queues.pageText, "preparePageText")({ plan: source.plan, receipt }));
        if (!prepared.success) return state("rejected");
        if (prepared.data.status === "review") return prepared.data.operationId === source.plan.page.operationId ? review(prepared.data.reviewId) : state("rejected");
        const task = prepared.data.task;
        if (task.operationId !== source.plan.textOperationId || task.source.kind !== "prepared" || task.range.start !== 0 ||
          task.source.document.producer.operationId !== source.plan.page.operationId || !same(observationIdentity(task), owner) ||
          Object.entries(source.plan.text).some(([k,v]) => task[k as keyof typeof task] !== v)) return state("rejected");
        preparedDocument = task.source.document; preparedRange = task.range;
        if (input.corePolicy) {
          const request = { owner, fullDocument: task.source.document };
          const core = LabelCoreOutcomeSchema.safeParse(await activity(queues.core!, "prepareLabelCore")(request));
          if (!core.success || !same(core.data.input, request)) return state("rejected");
          preparedDocument = core.data.document; preparedRange = core.data.range;
        }
      } else if (source.kind === "file-image") {
        let receipt: FileAcquireOutcome | null = null;
        try { receipt = FileAcquireOutcomeSchema.parse(await activity(queues.acquire, "acquireSourceFile")(source.plan.acquire)); }
        catch (error) { if (isCancellation(error)) throw error; }
        const prepared = ImageOcrPrepareOutcomeSchema.safeParse(await activity(queues.imagePrepare, "prepareImageOcr")({ plan: source.plan, receipt }));
        if (!prepared.success) return state("rejected");
        if (prepared.data.status === "review") return prepared.data.operationId === source.plan.acquire.operationId ? review(prepared.data.reviewId) : state("rejected");
        const task = prepared.data.task;
        if (task.operationId !== source.plan.ocrOperationId || task.file.kind !== "source-image" || task.file.artifactId !== source.plan.imageId ||
          task.file.producer.operationId !== source.plan.acquire.operationId || !same(observationIdentity(task), owner) ||
          Object.entries(source.plan.ocr).some(([k,v]) => task[k as keyof typeof task] !== v)) return state("rejected");
        let outcome: OcrActivityOutcome | null = null;
        try { outcome = OcrActivityOutcomeSchema.parse(await activity(queues.ocr, "ocrFile", true)(task)); }
        catch (error) { if (isCancellation(error)) throw error; }
        const receiptOcr = OcrReceiptOutcomeSchema.safeParse(await activity(queues.ocrReceipts, "resolveOcrReceipt")({ input: task, outcome }));
        if (!receiptOcr.success) return state("rejected");
        if (receiptOcr.data.status === "review") return receiptOcr.data.operationId === task.operationId && receiptOcr.data.imageId === task.file.artifactId ? review(receiptOcr.data.reviewId) : state("rejected");
        if (!same(receiptOcr.data.registration.input, task)) return state("rejected");
        const kw = await activity(queues.keywords, "screenImageKeywords")(receiptOcr.data.registration) as { status?: string; reviewId?: string };
        if (kw?.status === "review" && ExecutionIdSchema.safeParse(kw.reviewId).success) return review(kw.reviewId!);
        const keyword = KeywordReceiptSchema.safeParse(kw);
        if (!keyword.success || keyword.data.selection.ocrOperationId !== task.operationId || !same(keyword.data.selection.image, task.file) ||
          !same(keyword.data.selection.observation, owner)) return state("rejected");
        preparedSelection = keyword.data.selection;
        // Even nonmatches go through single-source read-only verification/publication.
      } else return state("rejected");
      const request = { input, sourceId: source.id };
      const resolved = GncLabelSourceOutcomeSchema.safeParse(await activity(queues.source, "prepareGncLabelSource")(request));
      if (!resolved.success || !same(resolved.data.input, request)) return state("rejected");
      if (resolved.data.status === "not_matched") return source.kind === "file-image" && (preparedSelection as { status: string }).status === "not_matched" ? state("not_matched") : state("rejected");
      const next = resolved.data.source;
      if (next.id !== source.id || !next.required || next.kind !== (source.kind === "page" ? "text" : "image")) return state("rejected");
      if (next.kind === "text") {
        if (next.task.source.kind !== "prepared" || !same(next.task.source.document, preparedDocument) || !same(next.task.range, preparedRange) ||
          !same(observationIdentity(next.task), owner) || Object.entries(input.text).some(([k,v]) => next.task[k as keyof typeof next.task] !== v)) return state("rejected");
        issued.set(source.id, next);
        const result = await PreparedTextWorkflow({ task: next.task, queues: { text: queues.text, receipts: queues.textReceipts } }, gate);
        return result.status === "review" ? review(result.reviewId) : state("registered");
      }
      if (!same(next.task.input.selection, preparedSelection) || !same(next.task.input.selection.observation, owner) || next.task.configFingerprint !== input.visionConfigFingerprint) return state("rejected");
      issued.set(source.id, next);
      const result = await activity(queues.vision, "interpretImage")(next.task) as { status?: string; reviewId?: string; operationId?: string };
      if (result?.status === "review" && ExecutionIdSchema.safeParse(result.reviewId).success) return review(result.reviewId!);
      return result?.status === "registered" && result.operationId === next.task.input.operationId ? state("registered") : state("rejected");
    } catch (error) {
      if (isCancellation(error)) throw error;
      if (error instanceof ApplicationFailure && ["TEXT_RECEIPT.INVALID_RECEIPT", "TEXT_RECEIPT.IDENTITY_CONFLICT"].includes(error.type ?? "")) return state("rejected");
      return state("unresolved"); // Evidence inspection only at the barrier; never re-execute an uncertain activity.
    } finally { finished++; }
  }));
  const finalized = GncLabelOutcomeSchema.safeParse(await activity(queues.manifest, "prepareGncLabel")(input));
  if (!finalized.success) invalid("Invalid final GNC manifest");
  const result = finalized.data;
  if (result.status === "review") { if (result.operationId !== input.operationId) invalid("Foreign final Review"); return result; }
  if (!same(result.input, input) || result.manifest.operationId !== input.operationId || !same(result.manifest.observation, owner) ||
    result.evidenceKey !== `v3/gnc-label-inputs/${input.operationId}/manifest.json`) invalid("Foreign final manifest");
  const selected = new Set(result.manifest.sources.map(s => s.id)), skipped = new Set(result.skipped);
  if (input.corePolicy && (result.manifest.admission?.policy !== "label-packaging/1" || result.manifest.admission.comparison !== "label-typography/2")) invalid("Missing core admission policy");
  if (result.manifest.sources.some(s => issued.has(s.id) && !same(issued.get(s.id), s))) invalid("Final task differs from executed task");
  if (skipped.size !== result.skipped.length || [...skipped].some(id => selected.has(id)) || selected.size + skipped.size !== states.length ||
    states.some(s => !selected.has(s.id) && !skipped.has(s.id))) invalid("Incomplete final source coverage");
  // Explicitly rejected skipped receipts remain foreign states so the assembly records Review.
  const joined = states.filter(s => selected.has(s.id) || !["not_matched", "unresolved"].includes(s.status))
    .map(s => selected.has(s.id) && s.status === "not_matched" ? { id: s.id, status: "rejected" as const } : s);
  return finishLabelProduct({ manifest: result.manifest, states: joined }, queues);
}
