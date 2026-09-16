import { proxyActivities, isCancellation, ApplicationFailure, patched } from "@temporalio/workflow";
import { PreparedTextWorkflowInputSchema, TextActivityOutcomeSchema, TextReceiptOutcomeSchema, TextInputSchema,
  textActivityOptions, type TextInput, type TextActivityOutcome, type TextReceiptInput, type TextReceiptOutcome } from "@crawl-automation/v3-contracts";

import type { ResourceActivityBinding } from "./resource-workflow.js";

/** One prepared text document; no OCR dependency and no product eligibility/collection claim. */
export async function PreparedTextWorkflow(raw: unknown, gate: <T>(name:string, run:(binding?:ResourceActivityBinding)=>Promise<T>)=>Promise<T> = (_name,run)=>run(), propagateAdmissionFailure = false): Promise<TextReceiptOutcome> {
  const parsed = PreparedTextWorkflowInputSchema.safeParse(raw);
  if (!parsed.success) throw ApplicationFailure.nonRetryable("Invalid prepared text plan", "TEXT_RECEIPT.INVALID_INPUT");
  const { task, queues } = parsed.data;
  const text = proxyActivities<{ interpretText(input: TextInput): Promise<unknown> }>(textActivityOptions(queues.text));
  const receipts = proxyActivities<{ resolveTextReceipt(input: TextReceiptInput): Promise<unknown> }>(textActivityOptions(queues.receipts));
  let outcome: TextActivityOutcome | null = null;
  const hardened=patched("model-activity-hardening-v1")?{heartbeatTimeout:"60 seconds" as const,retry:{maximumAttempts:2}}:{};
  try { outcome = TextActivityOutcomeSchema.parse(await gate("interpretText",binding=>binding?proxyActivities<{interpretText(input:TextInput):Promise<unknown>}>({...textActivityOptions(queues.text),...hardened,...binding}).interpretText(task):text.interpretText(task))); }
  catch (error) {
    if (isCancellation(error) || propagateAdmissionFailure && error instanceof ApplicationFailure &&
      ["RESOURCE.WAIT_LIMIT","RESOURCE.OWNER_QUARANTINED","RESOURCE.REVIEW_STOP_UNVERIFIED"].includes(error.type??'')) throw error;
    /* Read-only reconciliation only when execution may have started; never execute twice. */
  }
  const decoded = TextReceiptOutcomeSchema.safeParse(await receipts.resolveTextReceipt({ input: task, outcome }));
  if (!decoded.success) throw ApplicationFailure.nonRetryable("Invalid text receipt", "TEXT_RECEIPT.INVALID_RECEIPT");
  const result = decoded.data;
  if (result.status === "registered" ? JSON.stringify(TextInputSchema.parse(result.registration.input)) !== JSON.stringify(task) : result.operationId !== task.operationId)
    throw ApplicationFailure.nonRetryable("Text receipt identity mismatch", "TEXT_RECEIPT.IDENTITY_CONFLICT");
  return result;
}
