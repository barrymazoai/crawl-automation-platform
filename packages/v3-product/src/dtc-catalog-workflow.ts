import { patched, proxyActivities, workflowInfo, startChild, ParentClosePolicy, WorkflowIdReusePolicy, ApplicationFailure, CancellationScope, isCancellation } from "@temporalio/workflow";
import { DtcStoppedCaptureReviewSchema, DtcScopeSkipSchema, CatalogDiscoverySchema, DtcProductJobSchema, DtcProductCaptureSchema, DtcProductHandoffSchema,
  ChannelPlanOutcomeSchema, FileAcquireOutcomeSchema, AcquisitionReviewSchema, imageActivityOptions, assertArtifactBelongsTo, type DtcProductJob } from "@crawl-automation/v3-contracts";
import { resourceGate } from "./resource-workflow.js";
import type {ChildWorkflowHandle} from "@temporalio/workflow";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const invalid = () => { throw ApplicationFailure.nonRetryable("Dtc product identity conflict", "DTC.PRODUCT_IDENTITY"); };
function failureCode(error: unknown): string {
  let current = error;
  for (let n = 0; n < 8 && current && typeof current === "object"; n++) {
    const value = current as { type?: unknown; cause?: unknown };
    if (typeof value.type === "string" && /^(SOURCE|DTC|ARTIFACT|RESOURCE)\.[A-Z_]+$/.test(value.type)) return value.type;
    current = value.cause;
  }
  return "DTC.BROWSER_PHASE_UNRESOLVED";
}

/** A selected product streams each durable file to the existing channel label workflow. */
export async function DtcCatalogProductWorkflow(raw: unknown): Promise<unknown> {
 const discovery=CatalogDiscoverySchema.parse(raw),info=workflowInfo();
 if(info.workflowId!==discovery.workflowId||discovery.scope.channel!=="dtc")invalid();
 const call=(queue:string,name:string,value:unknown)=>proxyActivities<Record<string,(raw:unknown)=>Promise<unknown>>>(name==="captureDtcProduct"&&patched("dtc-legacy-capture-timeout/1")?{...imageActivityOptions(queue),startToCloseTimeout:"20 minutes",scheduleToCloseTimeout:"30 minutes"}:imageActivityOptions(queue))[name]!(value);
 const job=DtcProductJobSchema.parse(await call(info.taskQueue,"prepareDtcProduct",discovery));
 if(!same(job.discovery,discovery))invalid();return streamProduct(job,info.taskQueue,call);
}

async function streamProduct(job:DtcProductJob,inputQueue:string,call:(queue:string,name:string,value:unknown)=>Promise<unknown>){
  let child:ChildWorkflowHandle<(raw:unknown)=>Promise<unknown>>|undefined,labelId:string|undefined,phase:unknown;
  const gate=resourceGate(job.resources);
  const seal=(status:"closed"|"failed")=>child!.signal("channelStreamSealed",{operationId:labelId,status});
  try{
    phase=await gate("browserSession",async()=>{
      let cleanupAllowed=true;
      try{
        const raw=await gate("captureDtcProduct",async()=>{
          const result=await call(job.queues.capture,"captureDtcProduct",job),stopped=DtcStoppedCaptureReviewSchema.safeParse(result);
          if(stopped.success){
            if(!patched("dtc-capture-review-release-v1"))invalid();
            const verified=await call(inputQueue,"verifyDtcCaptureReview",{job,receipt:stopped.data});
            if(!same(verified,stopped.data))invalid();return verified;
          }
          return result;
        }),review=AcquisitionReviewSchema.safeParse(raw);
        const stopped=DtcStoppedCaptureReviewSchema.safeParse(raw);if(stopped.success)return stopped.data;
        const skipped=DtcScopeSkipSchema.safeParse(raw);
        if(skipped.success){if(skipped.data.operationId!==job.operationId||skipped.data.url!==job.discovery.entry.url||skipped.data.evidenceKey!==`v3/dtc-legacy/${job.operationId}/scope-skip.json`)invalid();return skipped.data;}
        if(review.success){if(review.data.operationId!==job.operationId)invalid();if(review.data.code==="SOURCE.BROWSER_USER_CONTROL")cleanupAllowed=false;return review.data;}
        const captured=DtcProductCaptureSchema.parse(raw),p=captured.sourcePlan,o=p.owner,d=job.discovery;
        if(!same(captured.job,job)||o.requestId!==d.catalogId||o.brandId!==d.scope.brandId||o.sourceId!==d.scope.sourceId||o.listingId!==d.entry.listingId||o.variantId!==d.entry.variantId||p.expectedUrl!==d.entry.url||p.binding.sessionId!==job.sessionId||p.source.producer.operationId!==job.operationId)invalid();
        const plan=ChannelPlanOutcomeSchema.parse(await call(job.queues.plan,"prepareChannelProduct",p));
        if(plan.operationId!==p.operationId)invalid();if(plan.status==="review")return plan;if(!same(plan.manifest.observation,o))invalid();
        // The retained page plan is sufficient to begin text work. Files are independently
        // admitted only after a durable receipt; no second browser/file pass is permitted.
        const prepared=DtcProductHandoffSchema.parse(await call(inputQueue,"prepareDtcStreamingLabel",captured));
        if(!same(prepared.job,job)||!same(prepared.input.input.sourcePlan,p))invalid();labelId=prepared.input.input.operationId;
        child=await startChild("ChannelStreamingLabelWorkflow",{workflowId:`${d.workflowId}-label`,taskQueue:job.queues.label,args:[prepared.input],
          parentClosePolicy:ParentClosePolicy.REQUEST_CANCEL,workflowIdReusePolicy:WorkflowIdReusePolicy.REJECT_DUPLICATE,retry:{maximumAttempts:1}});
        for(const source of plan.manifest.sources)if(source.kind==="file-image"){
          const receipt=FileAcquireOutcomeSchema.parse(await call(job.queues.file,"acquireDtcFile",{job,sourcePlan:p,input:source.plan.acquire}));
          if(receipt.operationId!==source.plan.acquire.operationId)invalid();
          if(receipt.status==="review"){if(receipt.code==="SOURCE.BROWSER_USER_CONTROL")cleanupAllowed=false;return receipt;}
          const f=receipt.file;assertArtifactBelongsTo(f,o);
          if(f.kind!=="source-image"||f.artifactId!==source.plan.imageId||f.producer.operationId!==source.plan.acquire.operationId||f.producer.module!=="file.acquire"||f.producer.implementationVersion!==source.plan.acquire.implementationVersion)invalid();
          await child.signal("channelSourceReady",{operationId:labelId,sourceId:source.id,file:f});
        }
        return null;
      }catch(error){if(failureCode(error)==="SOURCE.BROWSER_USER_CONTROL")cleanupAllowed=false;throw error;}
      finally{if(cleanupAllowed)await CancellationScope.nonCancellable(async()=>{
        const r=await call(job.queues.capture,"closeDtcProductPage",job) as {taskId?:string;status?:string};
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
    const r=AcquisitionReviewSchema.parse(await call(job.queues.review,"reviewDtcProduct",{job,code:"DTC.BROWSER_PHASE_UNRESOLVED",causeCode:failureCode(error)}));
    if(r.operationId!==job.operationId)invalid();
    if(child)await child.result();return r;
  }
  if(!child){
    const stopped=DtcStoppedCaptureReviewSchema.safeParse(phase);
    if(stopped.success){
      const receipt=AcquisitionReviewSchema.parse(await call(job.queues.review,"reviewDtcProduct",{job,code:"DTC.CAPTURE_INCOMPLETE",causeCode:"DTC.EVIDENCE_REVIEW",stop:stopped.data}));
      if(receipt.operationId!==job.operationId||receipt.code!=="DTC.CAPTURE_INCOMPLETE")invalid();return receipt;
    }
    const skipped=DtcScopeSkipSchema.safeParse(phase);
    if(skipped.success){const receipt=DtcScopeSkipSchema.parse(await call(job.queues.review,"recordDtcScopeSkip",{job,receipt:skipped.data}));if(!same(receipt,skipped.data))invalid();return receipt;}
    return phase;
  }
  // Final collection is gated on exact page closure and browser lease release.
  await seal(phase?"failed":"closed");
  const result=await child.result();return phase??result;
}
