import { patched, proxyActivities, startChild, continueAsNew, ParentClosePolicy, workflowInfo, isCancellation, ApplicationFailure, WorkflowIdReusePolicy } from "@temporalio/workflow";
import { CatalogWorkflowInputSchema, CatalogPageSchema, CatalogCommitSchema, PresenceInputSchema,
  CatalogDiscoverySchema, GncStreamingLabelWorkflowInputSchema,CatalogProductBindingSchema,
  type CatalogPage, type CatalogPageInput, type CatalogCommit, type CatalogDiscovery, type CatalogWorkflowInput, type PresenceInput, type PresenceResult } from "@crawl-automation/v3-contracts";
const options = (taskQueue: string) => ({ taskQueue, startToCloseTimeout: "2 minutes" as const, scheduleToCloseTimeout: "20 minutes" as const, retry: { maximumAttempts: 1 } });
import { resourceGate } from "./resource-workflow.js";
type Ledger = {
  commitCatalogPage(page: CatalogPage): Promise<CatalogCommit>;
  recordCatalogDispatch(input: { discovery: CatalogDiscovery; workflowId: string; runId: string }): Promise<void>;
  closeCatalog(input: { catalogId: string; scope: CatalogWorkflowInput["scope"]; failure: string | null }): Promise<{ status: "complete" | "incomplete" }>;
};
/** One bounded page at a time; children outlive catalog failure, closure and Continue-As-New. */
export async function CatalogWorkflow(raw: unknown): Promise<unknown> {
  const input = CatalogWorkflowInputSchema.parse(raw), ledger = proxyActivities<Ledger>(options(input.queues.ledger));
  if ((input.productWorkflow === "SwansonCatalogProductWorkflow" && input.scope.channel !== "swanson") || (input.productWorkflow === "AmazonCatalogProductWorkflow" && input.scope.channel !== "amazon") || (["DtcCatalogProductWorkflow", "DtcCatalogProductV2Workflow"].includes(input.productWorkflow ?? '') && input.scope.channel !== "dtc"))
    throw ApplicationFailure.nonRetryable("Foreign channel route", "CATALOG.PRODUCT_ROUTE");
  const source = proxyActivities<{ readCatalogPage(input: CatalogPageInput): Promise<CatalogPage> }>(input.scope.channel==="dtc"&&patched("dtc-legacy-catalog-timeout/1")?{...options(input.queues.source),startToCloseTimeout:"20 minutes",scheduleToCloseTimeout:"30 minutes",heartbeatTimeout:"10 seconds"}:options(input.queues.source));
  let pageIndex = input.page, cursor = input.cursor;
  const gate=resourceGate(input.resources);
  for (let count = 0; count < input.pagesPerRun; count++) {
    let page: CatalogPage, committed: CatalogCommit;
    let failure = "CATALOG.SOURCE_UNRESOLVED";
    try {
      const next = { catalogId: input.catalogId, scope: input.scope, page: pageIndex, cursor };
      page = CatalogPageSchema.parse(await gate("readCatalogPage",()=>source.readCatalogPage(next)));
      if (JSON.stringify(page.input) !== JSON.stringify(next)) throw Error("CATALOG.PAGE_IDENTITY");
      failure = "CATALOG.COMMIT_UNRESOLVED";
      committed = CatalogCommitSchema.parse(await ledger.commitCatalogPage(page));
      if (JSON.stringify(committed.input) !== JSON.stringify(next) || committed.completion !== page.completion || committed.nextCursor !== page.nextCursor)
        throw Error("CATALOG.RECEIPT_IDENTITY");
      for (const discovery of committed.discoveries) {
        failure = "CATALOG.DISPATCH_UNRESOLVED";
        if (discovery.catalogId !== input.catalogId || JSON.stringify(discovery.scope) !== JSON.stringify(input.scope)) throw Error("CATALOG.DISCOVERY_IDENTITY");
        const child = await startChild(input.productWorkflow ?? "CatalogProductWorkflow", { workflowId: discovery.workflowId, taskQueue: input.queues.product,
          args: [discovery], parentClosePolicy: ParentClosePolicy.ABANDON, workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE, retry: { maximumAttempts: 1 } });
        // startChild waits only for a durable start, never for product processing completion.
        await ledger.recordCatalogDispatch({ discovery, workflowId: child.workflowId, runId: child.firstExecutionRunId });
      }
    } catch (error) {
      if (isCancellation(error)) throw error;
      // Unknown dispatch is not automatically repeated. Already-started children are untouched.
      return ledger.closeCatalog({ catalogId: input.catalogId, scope: input.scope, failure });
    }
    if (page.completion !== "more") return ledger.closeCatalog({ catalogId: input.catalogId, scope: input.scope, failure: null });
    cursor = page.nextCursor; pageIndex++;
    if(input.maxPages!==undefined&&pageIndex>=input.maxPages)return ledger.closeCatalog({catalogId:input.catalogId,scope:input.scope,failure:"CATALOG.BOUNDED_LIMIT"});
  }
  if (pageIndex > 100000) throw ApplicationFailure.nonRetryable("Catalog page limit", "CATALOG.LIMIT");
  return continueAsNew<typeof CatalogWorkflow>({ ...input, cursor, page: pageIndex });
}
export async function PresenceWorkflow(raw: { input: PresenceInput; queue: string }): Promise<PresenceResult> {
  const input = PresenceInputSchema.parse(raw.input);
  return proxyActivities<{ checkPresence(input: PresenceInput): Promise<PresenceResult> }>(options(raw.queue)).checkPresence(input);
}
export async function CatalogProductWorkflow(raw: unknown): Promise<unknown> {
  const discovery = CatalogDiscoverySchema.parse(raw);
  const prepared = CatalogProductBindingSchema.parse(await proxyActivities<{ prepareCatalogProduct(d: CatalogDiscovery): Promise<unknown> }>(options(workflowInfo().taskQueue)).prepareCatalogProduct(discovery));
  const input = GncStreamingLabelWorkflowInputSchema.parse(prepared.input), owner = input.input.sourcePlan.task.owner;
  if (discovery.scope.channel !== "gnc" || discovery.entry.kind !== "product" || owner.brandId !== discovery.scope.brandId ||
      owner.sourceId !== discovery.scope.sourceId || owner.listingId !== discovery.entry.listingId || owner.variantId !== discovery.entry.variantId ||
      input.input.sourcePlan.task.capture.url !== discovery.entry.url) throw ApplicationFailure.nonRetryable("Product identity conflict", "CATALOG.PRODUCT_IDENTITY");
  const child = await startChild(prepared.browserPhase?"GncLeasedProductWorkflow":"GncStreamingLabelWorkflow", { workflowId: `${discovery.workflowId}-gnc`, taskQueue: prepared.queue,
    args: [input], parentClosePolicy: ParentClosePolicy.ABANDON, workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE, retry: { maximumAttempts: 1 } });
  return child.result();
}
