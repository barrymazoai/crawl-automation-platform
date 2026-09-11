import { proxyActivities, isCancellation, ApplicationFailure } from "@temporalio/workflow";
import { PageTextWorkflowInputSchema, PagePrepareOutcomeSchema, PageTextPrepareOutcomeSchema, observationIdentity,
  imageActivityOptions, type PagePrepareInput, type PagePrepareOutcome, type PageTextPrepareInput } from "@crawl-automation/v3-contracts";
import { PreparedTextWorkflow } from "./text-workflow.js";
/** One captured HTML artifact; preparation, input assembly and model execution are separate consumers. */
export async function PageTextWorkflow(raw: unknown) {
  const parsed = PageTextWorkflowInputSchema.safeParse(raw);
  if (!parsed.success) throw ApplicationFailure.nonRetryable("Invalid page plan", "PAGE.INVALID_INPUT");
  const { plan, queues } = parsed.data;
  const pages = proxyActivities<{ prepareHtmlPage(input: PagePrepareInput): Promise<unknown> }>(imageActivityOptions(queues.page));
  const prepare = proxyActivities<{ preparePageText(input: PageTextPrepareInput): Promise<unknown> }>(imageActivityOptions(queues.prepare));
  let receipt: PagePrepareOutcome | null = null;
  try { receipt = PagePrepareOutcomeSchema.parse(await pages.prepareHtmlPage(plan.page)); }
  catch (error) { if (isCancellation(error)) throw error; /* Only inspect; never parse again. */ }
  const decoded = PageTextPrepareOutcomeSchema.safeParse(await prepare.preparePageText({ plan, receipt }));
  if (!decoded.success) throw ApplicationFailure.nonRetryable("Invalid page result", "PAGE.INVALID_RECEIPT");
  const result = decoded.data;
  if (result.status === "review") {
    if (result.operationId !== plan.page.operationId) throw ApplicationFailure.nonRetryable("Wrong page operation", "PAGE.IDENTITY_CONFLICT");
    return result;
  }
  const task = result.task;
  if (task.operationId !== plan.textOperationId || task.source.kind !== "prepared" ||
    task.source.document.producer.module !== "page.prepare" || task.source.document.producer.operationId !== plan.page.operationId ||
    task.source.document.producer.implementationVersion !== plan.page.implementationVersion ||
    task.range.start !== 0 || JSON.stringify(observationIdentity(task)) !== JSON.stringify(observationIdentity(plan.page)) ||
    Object.entries(plan.text).some(([k, v]) => task[k as keyof typeof task] !== v))
    throw ApplicationFailure.nonRetryable("Wrong text input", "PAGE.IDENTITY_CONFLICT");
  return PreparedTextWorkflow({ task, queues: { text: queues.text, receipts: queues.receipts } });
}
