import { proxyActivities, workflowInfo, startChild, ParentClosePolicy, WorkflowIdReusePolicy, ApplicationFailure, CancellationScope, isCancellation } from "@temporalio/workflow";
import { CatalogDiscoverySchema, AmazonProductJobSchema, AmazonProductCaptureSchema, AmazonProductHandoffSchema,
  ChannelPlanOutcomeSchema, FileAcquireOutcomeSchema, AcquisitionReviewSchema, imageActivityOptions, assertArtifactBelongsTo, type AmazonProductJob } from "@crawl-automation/v3-contracts";
import { resourceGate } from "./resource-workflow.js";
import type {ChildWorkflowHandle} from "@temporalio/workflow";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const invalid = () => { throw ApplicationFailure.nonRetryable("Amazon product identity conflict", "AMAZON.PRODUCT_IDENTITY"); };
function failureCode(error: unknown): string {
  let current = error;
  for (let n = 0; n < 8 && current && typeof current === "object"; n++) {
    const value = current as { type?: unknown; cause?: unknown };
    if (typeof value.type === "string" && /^(SOURCE|AMAZON|ARTIFACT|RESOURCE)\.[A-Z_]+$/.test(value.type)) return value.type;
    current = value.cause;
  }
  return "AMAZON.BROWSER_PHASE_UNRESOLVED";
}

/** A selected ASIN streams each durable file to the existing channel label workflow. */
export async function AmazonCatalogProductWorkflow(raw: unknown): Promise<unknown> {
 const discovery=CatalogDiscoverySchema.parse(raw),info=workflowInfo();
 if(info.workflowId!==discovery.workflowId||discovery.scope.channel!=="amazon")invalid();
 const call=(queue:string,name:string,value:unknown)=>proxyActivities<Record<string,(raw:unknown)=>Promise<unknown>>>(imageActivityOptions(queue))[name]!(value);
 const job=AmazonProductJobSchema.parse(await call(info.taskQueue,"prepareAmazonProduct",discovery));
 if(!same(job.discovery,discovery))invalid();return streamProduct(job,info.taskQueue,call);
}

async function streamProduct(job:AmazonProductJob,inputQueue:string,call:(queue:string,name:string,value:unknown)=>Promise<unknown>){
  let child:ChildWorkflowHandle<(raw:unknown)=>Promise<unknown>>|undefined,labelId:string|undefined,phase:unknown;
  const seal=(status:"closed"|"failed")=>child!.signal("channelStreamSealed",{operationId:labelId,status});
  try{
    phase=await resourceGate(job.resources)("browserSession",async()=>{
      let cleanupAllowed=true;
      try{
        const raw=await call(job.queues.capture,"captureAmazonProduct",job),review=AcquisitionReviewSchema.safeParse(raw);
        if(review.success){if(review.data.operationId!==job.operationId)invalid();if(review.data.code==="SOURCE.BROWSER_USER_CONTROL")cleanupAllowed=false;return review.data;}
        const captured=AmazonProductCaptureSchema.parse(raw),p=captured.sourcePlan,o=p.owner,d=job.discovery;
        if(!same(captured.job,job)||o.requestId!==d.catalogId||o.brandId!==d.scope.brandId||o.sourceId!==d.scope.sourceId||o.listingId!==d.entry.listingId||o.variantId!==d.entry.variantId||p.expectedUrl!==d.entry.url||p.binding.sessionId!==job.sessionId||p.source.producer.operationId!==job.operationId)invalid();
        const plan=ChannelPlanOutcomeSchema.parse(await call(job.queues.plan,"prepareChannelProduct",p));
        if(plan.operationId!==p.operationId)invalid();if(plan.status==="review")return plan;if(!same(plan.manifest.observation,o))invalid();
        // The retained page plan is sufficient to begin text work. Files are independently
        // admitted only after a durable receipt; no second browser/file pass is permitted.
        const prepared=AmazonProductHandoffSchema.parse(await call(inputQueue,"prepareAmazonStreamingLabel",captured));
        if(!same(prepared.job,job)||!same(prepared.input.input.sourcePlan,p))invalid();labelId=prepared.input.input.operationId;
        child=await startChild("ChannelStreamingLabelWorkflow",{workflowId:`${d.workflowId}-label`,taskQueue:job.queues.label,args:[prepared.input],
          parentClosePolicy:ParentClosePolicy.REQUEST_CANCEL,workflowIdReusePolicy:WorkflowIdReusePolicy.REJECT_DUPLICATE,retry:{maximumAttempts:1}});
        for(const source of plan.manifest.sources)if(source.kind==="file-image"){
          const receipt=FileAcquireOutcomeSchema.parse(await call(job.queues.file,"acquireAmazonFile",{job,sourcePlan:p,input:source.plan.acquire}));
          if(receipt.operationId!==source.plan.acquire.operationId)invalid();
          if(receipt.status==="review"){if(receipt.code==="SOURCE.BROWSER_USER_CONTROL")cleanupAllowed=false;return receipt;}
          const f=receipt.file;assertArtifactBelongsTo(f,o);
          if(f.kind!=="source-image"||f.artifactId!==source.plan.imageId||f.producer.operationId!==source.plan.acquire.operationId||f.producer.module!=="file.acquire"||f.producer.implementationVersion!==source.plan.acquire.implementationVersion)invalid();
          await child.signal("channelSourceReady",{operationId:labelId,sourceId:source.id,file:f});
        }
        return null;
      }catch(error){if(failureCode(error)==="SOURCE.BROWSER_USER_CONTROL")cleanupAllowed=false;throw error;}
      finally{if(cleanupAllowed)await CancellationScope.nonCancellable(async()=>{
        const r=await call(job.queues.capture,"closeAmazonProductPage",job) as {taskId?:string;status?:string};
        if(r?.taskId!==job.sessionId||!["closed","not-opened"].includes(r?.status??""))throw ApplicationFailure.nonRetryable("Page closure unverified","SOURCE.PAGE_CLOSE_UNKNOWN");
      });}
    });
  }catch(error){
    if(isCancellation(error)){
      if(child)await CancellationScope.nonCancellable(async()=>{try{await seal("failed");}catch{/* REQUEST_CANCEL also covers a terminated parent. */}});
      throw error;
    }
    // Publish failure to the running child before recording a Review: receipt persistence
    // can itself fail, and must not leave file waiters orphaned.
    if(child)await seal("failed");
    const r=AcquisitionReviewSchema.parse(await call(job.queues.review,"reviewAmazonProduct",{job,code:"AMAZON.BROWSER_PHASE_UNRESOLVED",causeCode:failureCode(error)}));
    if(r.operationId!==job.operationId)invalid();
    if(child)await child.result();return r;
  }
  if(!child)return phase;
  // Final collection is gated on exact page closure and browser lease release.
  await seal(phase?"failed":"closed");
  const result=await child.result();return phase??result;
}
