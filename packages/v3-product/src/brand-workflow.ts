import { proxyActivities,workflowInfo,startChild,ParentClosePolicy,WorkflowIdReusePolicy,sleep,ApplicationFailure,patched } from "@temporalio/workflow";
import { CollectionWorkflowInput,BrandCollectionPlanSchema,BrandCollectionProgressSchema } from "@crawl-automation/v3-contracts";
/** Stable intake root. Catalog may Continue-As-New; source guard stays until products settle. */
export async function BrandCollectionWorkflow(raw:unknown){
  const input=CollectionWorkflowInput.parse(raw),info=workflowInfo();
  if(info.workflowId!==`v3-collection-${input.requestId}`)throw ApplicationFailure.nonRetryable("Invalid intake root","BRAND.IDENTITY");
  // Normal progress polling may continue; a failed Activity is never retried.
  // Historical retry options remain only for deterministic replay.
  const resilient=patched("brand-inspect-retry-v1");
  const ports=proxyActivities<{prepareBrandCollection(raw:unknown):Promise<unknown>;inspectBrandCollection(raw:unknown):Promise<unknown>}>(patched("no-automatic-retries-v1")
    ?{taskQueue:info.taskQueue,startToCloseTimeout:"30 seconds",scheduleToCloseTimeout:"2 minutes",retry:{maximumAttempts:1}}
    :resilient
    ?{taskQueue:info.taskQueue,startToCloseTimeout:"30 seconds",scheduleToCloseTimeout:"6 hours",retry:{initialInterval:"5 seconds",maximumInterval:"2 minutes",backoffCoefficient:2}}
    :{taskQueue:info.taskQueue,startToCloseTimeout:"30 seconds",scheduleToCloseTimeout:"2 minutes",retry:{maximumAttempts:3}});
  const plan=BrandCollectionPlanSchema.parse(await ports.prepareBrandCollection(input));
  if(plan.catalog.catalogId!==input.requestId||plan.catalog.scope.brandId!==input.snapshot.brandId||plan.catalog.scope.sourceId!==input.snapshot.sourceId||plan.catalog.scope.rootUrl!==input.snapshot.url)
    throw ApplicationFailure.nonRetryable("Foreign catalog plan","BRAND.IDENTITY");
  const child=await startChild(plan.catalog.productWorkflow==='DtcCatalogProductV2Workflow'?'DtcCatalogWorkflow':"CatalogWorkflow",{workflowId:`${info.workflowId}-catalog`,taskQueue:plan.catalogQueue,args:[plan.catalog],parentClosePolicy:ParentClosePolicy.ABANDON,workflowIdReusePolicy:WorkflowIdReusePolicy.REJECT_DUPLICATE,retry:{maximumAttempts:1}});
  await child.result();
  for(let polls=0;;polls++){
    const progress=BrandCollectionProgressSchema.parse(await ports.inspectBrandCollection(input));
    if(progress.catalogId!==input.requestId)throw ApplicationFailure.nonRetryable("Foreign progress","BRAND.IDENTITY");
    if(progress.settled)return {codec:"brand-collection-settled/1",requestId:input.requestId,...progress};
    // Back off the poll so a long-running root does not grow its history by ~5 events every 10 seconds.
    await sleep(resilient?(polls<60?"10 seconds":polls<240?"30 seconds":"60 seconds"):"10 seconds");
  }
}
