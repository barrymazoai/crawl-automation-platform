import { proxyActivities, ApplicationFailure, isCancellation, patched } from "@temporalio/workflow";
import { ChannelSavedLabelWorkflowInputSchema, ChannelLabelPlanResultSchema, ChannelLabelSourceResultSchema, ChannelLabelManifestResultSchema, ChannelLabelImageCheckSchema,
  PagePrepareOutcomeSchema, PageTextPrepareOutcomeSchema, ImageOcrPrepareOutcomeSchema, OcrActivityOutcomeSchema, OcrReceiptOutcomeSchema,
  KeywordReceiptSchema, AcquisitionReviewSchema, ExecutionIdSchema, observationIdentity, imageActivityOptions, ocrActivityOptions,
  LabelCoreOutcomeSchema,type LabelProductJoin, type OcrActivityOutcome, type SavedProductWorkflowInput } from "@crawl-automation/v3-contracts";
import { resourceGate } from "./resource-workflow.js";
import { PreparedTextWorkflow } from "./text-workflow.js";
import { finishLabelProduct } from "./label-workflow.js";
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const invalid=()=>{throw ApplicationFailure.nonRetryable("Channel source identity conflict","CHANNEL.LABEL_IDENTITY_CONFLICT");};
/** Browser phase is already closed. Each saved source advances independently through atomic queues. */
export async function ChannelSavedLabelWorkflow(raw:unknown){
  return runChannelLabelWorkflow(raw);
}
export interface ChannelSourceProgress {
  ready(source:SavedProductWorkflowInput["manifest"]["sources"][number]):Promise<boolean>;
  finish():Promise<boolean>;
}
export async function runChannelLabelWorkflow(raw:unknown,progress?:ChannelSourceProgress){
  const {input,queues,resources}=ChannelSavedLabelWorkflowInputSchema.parse(raw),owner=input.sourcePlan.owner,gate=resourceGate(resources,{requireReviewStop:input.evidencePolicy==="label-image-first/5"});
  const skipUnstarted=patched("channel-resource-wait-no-receipt-v1"),waitingSources:string[]=[],quarantinedSources:string[]=[];
  // Model/OCR calls: a 10 s heartbeat window was lost to a single CPU stall on a cloud worker; 60 s tolerates it, and one
  // retry lets the task move to another worker (results are idempotent per operation, so a duplicate attempt only costs a call).
  const hardened=patched("model-activity-hardening-v1");
  const optionsFor=(queue:string,name:string)=>{const base=name==="ocrFile"?ocrActivityOptions(queue):imageActivityOptions(queue);
    return hardened&&["ocrFile","interpretImage"].includes(name)?{...base,heartbeatTimeout:"60 seconds" as const,retry:{maximumAttempts:2}}:base;};
  const call=(queue:string,name:string,value:unknown)=>gate(name,binding=>proxyActivities<Record<string,(raw:unknown)=>Promise<unknown>>>(
    {...optionsFor(queue,name),...binding})[name]!(value));
  const loaded=ChannelLabelPlanResultSchema.parse(await call(queues.plan,"loadChannelLabelPlan",input));
  if(!same(loaded.input,input)||!same(loaded.manifest.observation,owner)||loaded.manifest.operationId!==input.sourcePlan.operationId)invalid();
  const issued=new Map<string,unknown>();
  const single=input.evidencePolicy==="label-image-first/5";
  type ImageSource=Extract<typeof loaded.manifest.sources[number],{kind:"file-image"}>;
  type OcrOutcome={kind:"state";state:LabelProductJoin["states"][number];ready:boolean}|{kind:"selection";selection:unknown};
  // OCR of one image up to its keyword screen: prepare -> ocrFile -> receipt -> keywords. Cheap (seconds per image on
  // the OCR lanes) and independent per image, so a single-label product can run it for all images at once.
  // Started per image in single-label mode; the ordered walk awaits each in turn, so an early image still advances while later originals are in flight.
  const ocrPending=new Map<string,Promise<OcrOutcome>>();
  const ocrImage=async(source:ImageSource):Promise<OcrOutcome>=>{
    const state=(status:"unresolved"|"rejected"|"registered"|"not_matched",ready=true):OcrOutcome=>({kind:"state",state:{id:source.id,status},ready});
    try{
      if(progress&&!await progress.ready(source))return state("unresolved",false);
      const p=ImageOcrPrepareOutcomeSchema.parse(await call(queues.imagePrepare,"prepareImageOcr",{plan:source.plan,receipt:null}));
      if(p.status==="review")return p.operationId===source.plan.acquire.operationId?{kind:"state",state:{id:source.id,status:"review",reviewId:p.reviewId},ready:true}:state("rejected");
      if(p.task.operationId!==source.plan.ocrOperationId||p.task.file.artifactId!==source.plan.imageId||!same(observationIdentity(p.task),owner))return state("rejected");
      let outcome:OcrActivityOutcome|null=null;
      try{outcome=OcrActivityOutcomeSchema.parse(await call(queues.ocr,"ocrFile",p.task));}catch(e){
        if(isCancellation(e)||skipUnstarted&&e instanceof ApplicationFailure&&["RESOURCE.WAIT_LIMIT","RESOURCE.OWNER_QUARANTINED","RESOURCE.REVIEW_STOP_UNVERIFIED"].includes(e.type??''))throw e;
      }
      const r=OcrReceiptOutcomeSchema.parse(await call(queues.ocrReceipts,"resolveOcrReceipt",{input:p.task,outcome}));
      if(r.status==="review")return r.operationId===p.task.operationId?{kind:"state",state:{id:source.id,status:"review",reviewId:r.reviewId},ready:true}:state("rejected");
      if(!same(r.registration.input,p.task))return state("rejected");
      const k=KeywordReceiptSchema.parse(await call(queues.keywords,"screenImageKeywords",r.registration));
      if(k.selection.ocrOperationId!==p.task.operationId||!same(k.selection.image,p.task.file)||!same(k.selection.observation,owner))return state("rejected");
      return {kind:"selection",selection:k.selection};
    }catch(error){
      if(isCancellation(error))throw error;
      if(skipUnstarted&&error instanceof ApplicationFailure&&error.type==="RESOURCE.WAIT_LIMIT")waitingSources.push(source.id);
      if(error instanceof ApplicationFailure&&["RESOURCE.OWNER_QUARANTINED","RESOURCE.REVIEW_STOP_UNVERIFIED"].includes(error.type??''))quarantinedSources.push(source.id);
      return state("unresolved");
    }
  };
  const processSource=async(source:typeof loaded.manifest.sources[number]):Promise<LabelProductJoin["states"][number]>=>{
    const state=(status:"unresolved"|"rejected"|"registered"|"not_matched")=>({id:source.id,status});
    let document:unknown,range:unknown,selection:unknown;
    try{
      if(progress&&!(source.kind==="file-image"&&ocrPending.has(source.id))&&!await progress.ready(source))return state("unresolved");
      if(source.kind==="page"){
        let receipt=null;try{receipt=PagePrepareOutcomeSchema.parse(await call(queues.page,"prepareHtmlPage",source.plan.page));}catch(e){if(isCancellation(e))throw e;}
        const p=PageTextPrepareOutcomeSchema.parse(await call(queues.pageText,"preparePageText",{plan:source.plan,receipt}));
        if(p.status==="review")return p.operationId===source.plan.page.operationId?{id:source.id,status:"review",reviewId:p.reviewId}:state("rejected");
        if(p.task.operationId!==source.plan.textOperationId||p.task.source.kind!=="prepared"||p.task.source.document.producer.operationId!==source.plan.page.operationId||!same(observationIdentity(p.task),owner))return state("rejected");
        document=p.task.source.document;range=p.task.range;
        if(input.corePolicy){
          const coreInput={owner,fullDocument:p.task.source.document};
          const core=LabelCoreOutcomeSchema.parse(await call(queues.core!,"prepareSwansonLabelCore",coreInput));
          if(!same(core.input,coreInput)||core.document.producer.implementationVersion!==input.corePolicy)return state("rejected");
          document=core.document;range=core.range;
        }
      }else if(source.kind==="file-image"){
        const o=await(ocrPending.get(source.id)??ocrImage(source));
        if(o.kind==="state")return o.state;
        selection=o.selection;
      }else return state("rejected");
      const request={input,sourceId:source.id},r=ChannelLabelSourceResultSchema.parse(await call(queues.source,"prepareChannelLabelSource",request));
      if(!same(r.input,request))return state("rejected");
      if(r.status==="not_matched")return source.kind==="file-image"&&(selection as {status:string}).status==="not_matched"?state("not_matched"):state("rejected");
      const next=r.source;
      if(next.id!==source.id||!next.required||next.kind!==(source.kind==="page"?"text":"image"))return state("rejected");
      if(next.kind==="text"){
        if(next.task.source.kind!=="prepared"||!same(next.task.source.document,document)||!same(next.task.range,range)||!same(observationIdentity(next.task),owner)||
          Object.entries(input.text).some(([k,v])=>next.task[k as keyof typeof next.task]!==v))return state("rejected");
        issued.set(source.id,next);
        const result=await PreparedTextWorkflow({task:next.task,queues:{text:queues.text,receipts:queues.textReceipts}},gate,skipUnstarted);
        return result.status==="review"?{id:source.id,status:"review",reviewId:result.reviewId}:state("registered");
      }
      if(!same(next.task.input.selection,selection)||next.task.configFingerprint!==input.visionConfigFingerprint)return state("rejected");
      issued.set(source.id,next);
      const result=await call(queues.vision,"interpretImage",next.task) as {status?:string;operationId?:string;reviewId?:string};
      if(result?.status==="review"&&ExecutionIdSchema.safeParse(result.reviewId).success)return{id:source.id,status:"review",reviewId:result.reviewId!};
      // "uploaded" = cloud-mode worker retained the result remotely; the Mini consumer registers it on first read.
      return (result?.status==="registered"||result?.status==="uploaded")&&result.operationId===next.task.input.operationId?state("registered"):state("rejected");
    }catch(error){
      if(isCancellation(error))throw error;
      if(skipUnstarted&&error instanceof ApplicationFailure&&error.type==="RESOURCE.WAIT_LIMIT")waitingSources.push(source.id);
      if(error instanceof ApplicationFailure&&["RESOURCE.OWNER_QUARANTINED","RESOURCE.REVIEW_STOP_UNVERIFIED"].includes(error.type??''))quarantinedSources.push(source.id);
      return state("unresolved");
    }
  };
  let selectedImageId:string|null=null;
  const notStarted:{id:string;status:"not_started"}[]=[];
  let states:LabelProductJoin["states"];
  if(single){
    const images=loaded.manifest.sources.filter(s=>s.kind==="file-image"),order=loaded.imageOrder;
    if(!order||new Set(order).size!==images.length||order.length!==images.length||images.some(s=>!order.includes(s.id)))invalid();
    // OCR every image at once; the ordered walk below still spends the image model only until the first complete label.
    if(patched("channel-parallel-image-ocr-v1"))for(const id of order!)ocrPending.set(id,ocrImage(images.find(s=>s.id===id)! as ImageSource));
    states=[];
    for(const id of order!){
      const source=images.find(s=>s.id===id)!;
      if(selectedImageId){
        // Every original file must still become durable; only model work is skipped (OCR already started stays cheap and is awaited, never abandoned).
        const pending=ocrPending.get(id);
        if(pending?(await pending).kind==="state"&&!(await pending as {ready:boolean}).ready:progress&&!await progress.ready(source))states.push({id,status:"unresolved"});
        else notStarted.push({id,status:"not_started"});
        continue;
      }
      const state=await processSource(source);states.push(state);
      if(state.status==="registered"){
        try{
          const request={input,sourceId:id},check=ChannelLabelImageCheckSchema.parse(await call(queues.source,"inspectChannelLabelImage",request));
          if(!same(check.input,request))invalid();if(check.complete)selectedImageId=id;
        }catch(error){if(isCancellation(error))throw error;states[states.length-1]={id,status:"unresolved"};break;}
      }
      if(["unresolved","rejected"].includes(state.status))break;
    }
    for(const source of loaded.manifest.sources.filter(s=>s.kind!=="file-image")){
      if(selectedImageId&&source.kind==="page"&&patched("channel-complete-image-skip-page-v1"))notStarted.push({id:source.id,status:"not_started"});
      else states.push(await processSource(source));
    }
    if(states.length+notStarted.length!==loaded.manifest.sources.length){
      // Unknown execution never authorizes another model call or successful assembly.
      for(const source of images.filter(s=>!states.some(r=>r.id===s.id)&&!notStarted.some(r=>r.id===s.id))){if(progress)await progress.ready(source);states.push({id:source.id,status:"unresolved"});}
    }
  }else states=await Promise.all(loaded.manifest.sources.map(processSource));
  if(progress&&!await progress.finish()){
    const r=AcquisitionReviewSchema.parse(await call(queues.review,"reviewChannelProduct",{input,states,code:"CHANNEL.LABEL_PREPARATION_UNVERIFIED"}));
    if(r.operationId!==input.operationId)invalid();return r;
  }
  if(waitingSources.length||quarantinedSources.length){
    const r=AcquisitionReviewSchema.parse(await call(queues.review,"reviewChannelProduct",{input,states,code:"CHANNEL.DEPENDENCY_UNAVAILABLE",
      failures:[...waitingSources.sort().map(sourceId=>({sourceId,code:"RESOURCE.WAIT_LIMIT",executionFact:"not_executed"})),
        ...quarantinedSources.sort().map(sourceId=>({sourceId,code:"RESOURCE.OWNER_QUARANTINED",executionFact:"unknown"}))]}));
    if(r.operationId!==input.operationId||r.code!=="CHANNEL.DEPENDENCY_UNAVAILABLE")invalid();return r;
  }
  let result;
  try{result=ChannelLabelManifestResultSchema.parse(await call(queues.manifest,single?"prepareChannelSingleLabelManifest":"prepareChannelLabelManifest",single?{input,states:[...states,...notStarted],selectedImageId}:input));}
  catch(error){
    if(isCancellation(error))throw error;
    const r=AcquisitionReviewSchema.parse(await call(queues.review,"reviewChannelProduct",{input,states,code:"CHANNEL.LABEL_PREPARATION_UNVERIFIED"}));
    if(r.operationId!==input.operationId)invalid();return r;
  }
  if(!same(result.input,input)||!same(result.manifest.observation,owner)||result.manifest.operationId!==input.operationId||result.manifest.evidencePolicy!==input.evidencePolicy)invalid();
  const selected=new Set(result.manifest.sources.map(s=>s.id)),skipped=new Set(result.skipped);
  if(skipped.size!==result.skipped.length||[...skipped].some(s=>selected.has(s))||selected.size+skipped.size!==states.length+notStarted.length||
    [...states,...notStarted].some(s=>!selected.has(s.id)&&!skipped.has(s.id))||result.manifest.sources.some(s=>issued.has(s.id)&&!same(issued.get(s.id),s)))invalid();
  return finishLabelProduct({manifest:result.manifest,states:states
    .filter(s=>selected.has(s.id)||!single&&!["not_matched","unresolved"].includes(s.status))
    .map(s=>selected.has(s.id)&&s.status==="not_matched"?{id:s.id,status:"rejected" as const}:s)},queues);
}
