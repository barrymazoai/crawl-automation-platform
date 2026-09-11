import { proxyActivities, workflowInfo, startChild, ParentClosePolicy, ChildWorkflowCancellationType, WorkflowIdReusePolicy, ApplicationFailure, CancellationScope, isCancellation, patched, sleep } from "@temporalio/workflow";
import { CatalogDiscoverySchema, SwansonProductJobSchema, SwansonProductCaptureSchema, SwansonProductHandoffSchema,
  ChannelPlanOutcomeSchema, FileAcquireOutcomeSchema, AcquisitionReviewSchema, imageActivityOptions, assertArtifactBelongsTo, type SwansonProductJob } from "@crawl-automation/v3-contracts";
import { resourceGate } from "./resource-workflow.js";
import type {ChildWorkflowHandle} from "@temporalio/workflow";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const invalid = () => { throw ApplicationFailure.nonRetryable("Swanson product identity conflict", "SWANSON.PRODUCT_IDENTITY"); };
function failureCode(error: unknown): string {
  let current = error;
  for (let n = 0; n < 8 && current && typeof current === "object"; n++) {
    const value = current as { type?: unknown; cause?: unknown };
    if (typeof value.type === "string" && /^(SOURCE|SWANSON|ARTIFACT|RESOURCE)\.[A-Z_]+$/.test(value.type)) return value.type;
    current = value.cause;
  }
  return "SWANSON.BROWSER_PHASE_UNRESOLVED";
}

/** Separate module queues; only the bounded browser phase holds the browser resource. */
export async function SwansonCatalogProductWorkflow(raw: unknown): Promise<unknown> {
  const discovery = CatalogDiscoverySchema.parse(raw), info = workflowInfo();
  if (info.workflowId !== discovery.workflowId || discovery.scope.channel !== "swanson") invalid();
  const call = (queue: string, name: string, value: unknown) => proxyActivities<Record<string, (raw: unknown) => Promise<unknown>>>(imageActivityOptions(queue))[name]!(value);
  const job = SwansonProductJobSchema.parse(await call(info.taskQueue, "prepareSwansonProduct", discovery));
  if (!same(job.discovery, discovery)) invalid();
  if(patched("swanson-family-variants-v1"))return familyProducts(job,info.taskQueue,call);
  if(patched("swanson-file-stream-v1"))return streamProduct(job,info.taskQueue,call);
  let sourcePlan: ReturnType<typeof SwansonProductCaptureSchema.parse>["sourcePlan"] | undefined;
  try {
    const phase = await resourceGate(job.resources)("browserSession", async () => {
      let cleanupAllowed = true;
      try {
        const rawCapture = await call(job.queues.capture, "captureSwansonProduct", job);
        const review = AcquisitionReviewSchema.safeParse(rawCapture);
        if (review.success) {
          if (review.data.operationId !== job.operationId) invalid();
          if (review.data.code === "SOURCE.BROWSER_USER_CONTROL") cleanupAllowed = false;
          return review.data;
        }
        const captured = SwansonProductCaptureSchema.parse(rawCapture);
        if (!same(captured.job, job)) invalid();
        const p = captured.sourcePlan, o = p.owner;
        if (o.requestId !== discovery.catalogId || o.brandId !== discovery.scope.brandId || o.sourceId !== discovery.scope.sourceId ||
          p.expectedUrl !== discovery.entry.url || p.binding.sessionId !== job.sessionId || p.source.producer.operationId !== job.operationId) invalid();
        sourcePlan = p;
        const plan = ChannelPlanOutcomeSchema.parse(await call(job.queues.plan, "prepareChannelProduct", p));
        if (plan.operationId !== p.operationId) invalid();
        if (plan.status === "review") return plan;
        if (!same(plan.manifest.observation, o)) invalid();
        for (const source of plan.manifest.sources) if (source.kind === "file-image") {
          const receipt = FileAcquireOutcomeSchema.parse(await call(job.queues.file, "acquireSwansonFile", { job, sourcePlan: p, input: source.plan.acquire }));
          if (receipt.operationId !== source.plan.acquire.operationId) invalid();
          if (receipt.status === "review") {
            if (receipt.code === "SOURCE.BROWSER_USER_CONTROL") cleanupAllowed = false;
            return receipt;
          }
          assertArtifactBelongsTo(receipt.file, o);
          if (receipt.file.kind !== "source-image" || receipt.file.producer.operationId !== source.plan.acquire.operationId) invalid();
        }
        return null;
      } catch (error) {
        // Explicit permission stops must not be followed by browser input/cleanup.
        if (failureCode(error) === "SOURCE.BROWSER_USER_CONTROL") cleanupAllowed = false;
        throw error;
      } finally {
        if (cleanupAllowed) await CancellationScope.nonCancellable(async () => {
          const closed = await call(job.queues.capture, "closeSwansonProductPage", job) as { taskId?: string; status?: string };
          if (closed?.taskId !== job.sessionId || !["closed", "not-opened"].includes(closed?.status ?? ""))
            throw ApplicationFailure.nonRetryable("Page closure unverified", "SOURCE.PAGE_CLOSE_UNKNOWN");
        });
      }
    });
    if (phase) return phase;
  } catch (error) {
    if (isCancellation(error)) throw error;
    // Keep unknown execution/cleanup permits quarantined; classification does not attest to release.
    const review = AcquisitionReviewSchema.parse(await call(job.queues.review, "reviewSwansonProduct", { job, code: "SWANSON.BROWSER_PHASE_UNRESOLVED", causeCode: failureCode(error) }));
    if (review.operationId !== job.operationId) invalid();
    return review;
  }
  if (!sourcePlan) invalid();
  const prepared = SwansonProductHandoffSchema.parse(await call(info.taskQueue, "prepareSwansonLabel", { job, sourcePlan }));
  if (!same(prepared.job, job) || !same(prepared.input.input.sourcePlan, sourcePlan)) invalid();
  // A new child Run owns a distinct resource permit sequence; browser has already closed/released.
  return (await startChild("ChannelSavedLabelWorkflow", { workflowId: `${discovery.workflowId}-label`, taskQueue: job.queues.label,
    args: [prepared.input], parentClosePolicy: ParentClosePolicy.ABANDON, workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE, retry: { maximumAttempts: 1 } })).result();
}

/** A family enumerates once and durably starts each distinct linked SKU. The
 * enumeration page is already closed before any child acquires its own page. */
async function familyProducts(job:SwansonProductJob,inputQueue:string,call:(queue:string,name:string,value:unknown)=>Promise<unknown>){
  const started:ChildWorkflowHandle<(raw:unknown)=>Promise<unknown>>[]=[];
  try{
    await resourceGate(job.resources)("browserSession",()=>call(job.queues.capture,"enumerateSwansonFamily",job));
    const raw=await call(inputQueue,"prepareSwansonFamilyProducts",job);
    if(!Array.isArray(raw)||!raw.length||raw.length>100)invalid();
    const ids=new Set<string>();
    for(const item of raw as {job:unknown;owned:boolean}[]){
      const child=SwansonProductJobSchema.parse(item.job),d=child.discovery;
      if(typeof item.owned!=="boolean"||!child.familyDiscovery||!same(d.scope,job.discovery.scope)||d.catalogId!==job.discovery.catalogId||ids.has(d.workflowId))invalid();
      ids.add(d.workflowId);
      if(item.owned){
        if(!same(child.familyDiscovery,job.discovery))invalid();
        started.push(await startChild("SwansonVariantProductWorkflow",{workflowId:d.workflowId,taskQueue:inputQueue,args:[{family:child.familyDiscovery,discovery:d}],
          // A global SKU may also be referenced by another family. Directory/family
          // cancellation must not cancel that independent product's bounded work.
          parentClosePolicy:ParentClosePolicy.ABANDON,cancellationType:ChildWorkflowCancellationType.ABANDON,
          workflowIdReusePolicy:WorkflowIdReusePolicy.REJECT_DUPLICATE,retry:{maximumAttempts:1}}));
      }
    }
    for(;;){
      const progress=await call(inputQueue,"inspectSwansonFamilyProducts",job) as {coverage?:string;states?:{workflowId:string;status:string;held:boolean}[]};
      if(!progress.states||progress.states.length!==ids.size||new Set(progress.states.map(s=>s.workflowId)).size!==ids.size||progress.states.some(s=>!ids.has(s.workflowId))||!["declared-options","selected-only"].includes(progress.coverage??""))invalid();
      const states=progress.states!;
      if(states.every(s=>!s.held&&s.status!=="RUNNING"&&s.status!=="PENDING")){
        if(states.some(s=>s.status!=="COMPLETED"))throw ApplicationFailure.nonRetryable("Inspect variant child evidence","SWANSON.VARIANT_EXECUTION_UNRESOLVED");
        return {status:"completed",coverage:progress.coverage,variants:states.length};
      }
      await sleep("2 seconds");
    }
  }catch(error){
    if(isCancellation(error))throw error;
    // A later dispatch/inspection failure does not roll back an already running SKU.
    await Promise.allSettled(started.map(child=>child.result()));
    const r=AcquisitionReviewSchema.parse(await call(job.queues.review,"reviewSwansonProduct",{job,code:"SWANSON.BROWSER_PHASE_UNRESOLVED",causeCode:failureCode(error)}));
    if(r.operationId!==job.operationId)invalid();return r;
  }
}

export async function SwansonVariantProductWorkflow(raw:{family:unknown;discovery:unknown}):Promise<unknown>{
  const info=workflowInfo(),d=CatalogDiscoverySchema.parse(raw.discovery),family=CatalogDiscoverySchema.parse(raw.family);
  if(info.workflowId!==d.workflowId||d.scope.channel!=="swanson"||family.scope.channel!=="swanson")invalid();
  const call=(queue:string,name:string,value:unknown)=>proxyActivities<Record<string,(raw:unknown)=>Promise<unknown>>>(imageActivityOptions(queue))[name]!(value);
  const job=SwansonProductJobSchema.parse(await call(info.taskQueue,"prepareSwansonVariantProduct",{family,discovery:d}));
  if(!same(job.discovery,d)||!same(job.familyDiscovery,family))invalid();
  return streamProduct(job,info.taskQueue,call);
}

async function streamProduct(job:SwansonProductJob,inputQueue:string,call:(queue:string,name:string,value:unknown)=>Promise<unknown>){
  let child:ChildWorkflowHandle<(raw:unknown)=>Promise<unknown>>|undefined,labelId:string|undefined,phase:unknown;
  const seal=(status:"closed"|"failed")=>child!.signal("channelStreamSealed",{operationId:labelId,status});
  try{
    phase=await resourceGate(job.resources)("browserSession",async()=>{
      let cleanupAllowed=true;
      try{
        const raw=await call(job.queues.capture,"captureSwansonProduct",job),review=AcquisitionReviewSchema.safeParse(raw);
        if(review.success){if(review.data.operationId!==job.operationId)invalid();if(review.data.code==="SOURCE.BROWSER_USER_CONTROL")cleanupAllowed=false;return review.data;}
        const captured=SwansonProductCaptureSchema.parse(raw),p=captured.sourcePlan,o=p.owner,d=job.discovery;
        if(!same(captured.job,job)||o.requestId!==d.catalogId||o.brandId!==d.scope.brandId||o.sourceId!==d.scope.sourceId||p.expectedUrl!==d.entry.url||p.binding.sessionId!==job.sessionId||p.source.producer.operationId!==job.operationId)invalid();
        const plan=ChannelPlanOutcomeSchema.parse(await call(job.queues.plan,"prepareChannelProduct",p));
        if(plan.operationId!==p.operationId)invalid();if(plan.status==="review")return plan;if(!same(plan.manifest.observation,o))invalid();
        // The retained page plan is sufficient to begin text work. Files are independently
        // admitted only after a durable receipt; no second browser/file pass is permitted.
        const prepared=SwansonProductHandoffSchema.parse(await call(inputQueue,"prepareSwansonStreamingLabel",captured));
        if(!same(prepared.job,job)||!same(prepared.input.input.sourcePlan,p))invalid();labelId=prepared.input.input.operationId;
        child=await startChild("ChannelStreamingLabelWorkflow",{workflowId:`${d.workflowId}-label`,taskQueue:job.queues.label,args:[prepared.input],
          parentClosePolicy:ParentClosePolicy.REQUEST_CANCEL,workflowIdReusePolicy:WorkflowIdReusePolicy.REJECT_DUPLICATE,retry:{maximumAttempts:1}});
        for(const source of plan.manifest.sources)if(source.kind==="file-image"){
          const receipt=FileAcquireOutcomeSchema.parse(await call(job.queues.file,"acquireSwansonFile",{job,sourcePlan:p,input:source.plan.acquire}));
          if(receipt.operationId!==source.plan.acquire.operationId)invalid();
          if(receipt.status==="review"){if(receipt.code==="SOURCE.BROWSER_USER_CONTROL")cleanupAllowed=false;return receipt;}
          const f=receipt.file;assertArtifactBelongsTo(f,o);
          if(f.kind!=="source-image"||f.artifactId!==source.plan.imageId||f.producer.operationId!==source.plan.acquire.operationId||f.producer.module!=="file.acquire"||f.producer.implementationVersion!==source.plan.acquire.implementationVersion)invalid();
          await child.signal("channelSourceReady",{operationId:labelId,sourceId:source.id,file:f});
        }
        return null;
      }catch(error){if(failureCode(error)==="SOURCE.BROWSER_USER_CONTROL")cleanupAllowed=false;throw error;}
      finally{if(cleanupAllowed)await CancellationScope.nonCancellable(async()=>{
        const r=await call(job.queues.capture,"closeSwansonProductPage",job) as {taskId?:string;status?:string};
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
    const r=AcquisitionReviewSchema.parse(await call(job.queues.review,"reviewSwansonProduct",{job,code:"SWANSON.BROWSER_PHASE_UNRESOLVED",causeCode:failureCode(error)}));
    if(r.operationId!==job.operationId)invalid();
    if(child)await child.result();return r;
  }
  if(!child)return phase;
  // Final collection is gated on exact page closure and browser lease release.
  await seal(phase?"failed":"closed");
  const result=await child.result();return phase??result;
}
