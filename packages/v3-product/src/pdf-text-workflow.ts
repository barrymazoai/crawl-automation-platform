import { proxyActivities, isCancellation, ApplicationFailure } from "@temporalio/workflow";
import { PdfTextWorkflowInputSchema, PdfTextPrepareOutcomeSchema, PdfActivityOutcomeSchema, observationIdentity,
  imageActivityOptions, type PdfInput, type PdfActivityOutcome, type PdfTextPrepareInput } from "@crawl-automation/v3-contracts";
import { PreparedTextWorkflow } from "./text-workflow.js";

/** Explicit single page; no OCR fallback or product-eligibility decision. */
export async function PdfTextWorkflow(raw: unknown) {
  const parsed = PdfTextWorkflowInputSchema.safeParse(raw);
  if (!parsed.success) throw ApplicationFailure.nonRetryable("Invalid PDF text plan", "PDF.INVALID_INPUT");
  const { plan, queues } = parsed.data;
  const extraction = proxyActivities<{ extractPdfPageText(input: PdfInput): Promise<unknown> }>(imageActivityOptions(queues.extraction));
  const prepare = proxyActivities<{ preparePdfText(input: PdfTextPrepareInput): Promise<unknown> }>(imageActivityOptions(queues.prepare));
  let receipt: PdfActivityOutcome | null = null;
  try { receipt = PdfActivityOutcomeSchema.parse(await extraction.extractPdfPageText(plan.extraction)); }
  catch (error) { if (isCancellation(error)) throw error; /* Only inspect retained completion, no re-extraction. */ }
  const decoded = PdfTextPrepareOutcomeSchema.safeParse(await prepare.preparePdfText({ plan, receipt }));
  if (!decoded.success) throw ApplicationFailure.nonRetryable("Invalid PDF preparation receipt", "PDF.INVALID_RECEIPT");
  const result = decoded.data;
  if (result.status === "review") {
    if (result.operationId !== plan.extraction.operationId) throw ApplicationFailure.nonRetryable("Wrong PDF operation", "PDF.IDENTITY_CONFLICT");
    return result;
  }
  const task = result.task;
  if (task.operationId !== plan.textOperationId || task.source.kind !== "prepared" ||
    task.source.document.producer.module !== "pdf.text" || task.source.document.producer.operationId !== plan.extraction.operationId ||
    task.source.document.producer.implementationVersion !== plan.extraction.implementationVersion || task.range.start !== 0 ||
    result.evidenceKey !== `v3/pdf-text-inputs/${plan.textOperationId}/input.json` ||
    JSON.stringify(observationIdentity(task)) !== JSON.stringify(observationIdentity(plan.extraction)) ||
    Object.entries(plan.text).some(([k, v]) => task[k as keyof typeof task] !== v))
    throw ApplicationFailure.nonRetryable("Wrong PDF text input", "PDF.IDENTITY_CONFLICT");
  return PreparedTextWorkflow({ task, queues: { text: queues.text, receipts: queues.receipts } });
}
