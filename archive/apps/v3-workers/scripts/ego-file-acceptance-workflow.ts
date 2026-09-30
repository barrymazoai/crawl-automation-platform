import { proxyActivities } from "@temporalio/workflow";
import { FileAcquireInputSchema,FileAcquireOutcomeSchema,GNC_PRODUCT_QUEUES,imageActivityOptions } from "@crawl-automation/v3-contracts";
// Acceptance-only workflow: one file per execution, no OCR/model/capture activities.
export async function EgoFileAcceptance(raw:unknown) {
  const input=FileAcquireInputSchema.parse(raw);
  const activity=proxyActivities<{acquireSourceFile(input:unknown):Promise<unknown>}>(imageActivityOptions(GNC_PRODUCT_QUEUES.files));
  const output=FileAcquireOutcomeSchema.parse(await activity.acquireSourceFile(input));
  if(output.operationId!==input.operationId)throw Error("FILE_RECEIPT_MISMATCH");
  return output;
}
