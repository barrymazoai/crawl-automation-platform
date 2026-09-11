import { proxyActivities,ApplicationFailure,patched,CancellationScope } from "@temporalio/workflow";
import { GncStreamingLabelWorkflowInputSchema,GncAcquireOutcomeSchema,GncProductPrepareOutcomeSchema,GncLabelPlanOutcomeSchema,FileAcquireOutcomeSchema,imageActivityOptions } from "@crawl-automation/v3-contracts";
import { resourceGate } from "./resource-workflow.js";
import { GncStreamingLabelWorkflow } from "./gnc-stream-workflow.js";
/** Browser-bound phase only. Each module is still an independent Activity/Worker.
 * Once HTML + original images are durable, release browser before OCR/model work.
 */
export async function GncLeasedProductWorkflow(raw:unknown) {
  const config=GncStreamingLabelWorkflowInputSchema.parse(raw),{input,queues}=config;
  if(config.start!=="capture"||!queues.acquireReceipts||!config.resources?.activities.browserSession||config.resources.activities.captureGncProduct||config.resources.activities.acquireSourceFile)
    throw ApplicationFailure.nonRetryable("Exclusive browser phase policy required","RESOURCE.BROWSER_POLICY");
  const call=(queue:string,name:string,value:unknown)=>proxyActivities<Record<string,(raw:unknown)=>Promise<unknown>>>(imageActivityOptions(queue))[name]!(value);
  const gate=resourceGate(config.resources);
  const phase=await gate("browserSession",async()=>{
    let cleanupAllowed=true;
    try {
    // Unknown acknowledgement escapes and quarantines the lease; never navigate next SKU on uncertainty.
    const captured=GncAcquireOutcomeSchema.parse(await call(queues.capture!,"captureGncProduct",input.sourcePlan.task));
    if(captured.operationId!==input.sourcePlan.task.capture.operationId)throw Error("GNC.BROWSER_PHASE_IDENTITY");
    if(captured.status==="review"){if(captured.code==="SOURCE.BROWSER_USER_CONTROL")cleanupAllowed=false;return captured;}
    const planned=GncProductPrepareOutcomeSchema.parse(await call(queues.productPlan!,"prepareGncProduct",{input:input.sourcePlan,receipt:captured}));
    if(planned.operationId!==input.sourcePlan.operationId)throw Error("GNC.BROWSER_PHASE_IDENTITY");
    if(planned.status==="review")return planned;
    const loaded=GncLabelPlanOutcomeSchema.parse(await call(queues.plan,"loadGncLabelPlan",input));
    if(JSON.stringify(loaded.input)!==JSON.stringify(input))throw Error("GNC.BROWSER_PHASE_IDENTITY");
    for(const source of loaded.manifest.sources)if(source.kind==="file-image"){
      const receipt=FileAcquireOutcomeSchema.parse(await call(queues.acquire,"acquireSourceFile",source.plan.acquire));
      if(receipt.operationId!==source.plan.acquire.operationId)throw Error("GNC.BROWSER_PHASE_IDENTITY");
      // Do not hide an uncertain file attempt behind a successful null browser phase.
      if(patched("gnc-file-review-quarantine-v1")&&receipt.status==="review"){if(receipt.code==="SOURCE.BROWSER_USER_CONTROL")cleanupAllowed=false;return receipt;}
    }
    return null;
    } finally {
      // Same capture Worker serializes cleanup after its activity. Exact owned target only;
      // permission stops fail closed. Cleanup failure quarantines the resource, never recrawls.
      if(patched("gnc-task-page-close-v1")&&cleanupAllowed)await CancellationScope.nonCancellable(async()=>{
        const result=await call(queues.capture!,"closeGncProductPage",input.sourcePlan.task) as {status?:string;taskId?:string};
        if(!["closed","not-opened"].includes(result?.status??"")||result.taskId!==input.sourcePlan.task.capture.binding.sessionId)
          throw ApplicationFailure.nonRetryable("Task page cleanup unconfirmed","SOURCE.PAGE_CLOSE_UNKNOWN");
      });
    }
  });
  if(phase)return phase;
  // Existing modules inspect retained evidence; they never repeat source requests on matching input.
  return GncStreamingLabelWorkflow({...config,start:"saved-plan",queues:{...queues,acquire:queues.acquireReceipts}},gate);
}
