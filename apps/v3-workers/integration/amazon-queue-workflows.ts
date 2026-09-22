// Test-only local Temporal tree. No network provider, browser, OCR or model calls.
import { startChild, workflowInfo, ParentClosePolicy, sleep } from "@temporalio/workflow";
export async function BrandCollectionWorkflow(input: any) {
  const child = await startChild(AmazonCatalogProductWorkflow, {
    workflowId: `${workflowInfo().workflowId}-product`, args: [input], parentClosePolicy: ParentClosePolicy.ABANDON,
  });
  await child.result();
  return { codec: "brand-collection-settled/1", requestId: input.requestId, settled: true };
}
export async function AmazonCatalogProductWorkflow(input: any) {
  await sleep(input.snapshot.brandName.endsWith(" slow") ? "1 hour" : "100 milliseconds");
  return { status: "observed", requestId: input.requestId };
}
