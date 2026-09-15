import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { ResourceRequestSchema, TextInputSchema, VisionTaskSchema, OcrInputSchema, observationIdentity, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { visionFingerprint } from "@crawl-automation/v3-vision";
import { RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
import { publishStoppedEvidence, resourceReturnKey } from "./stopped-evidence.js";
type Invocation={workflowId:string;runId:string;activityId:string;activityName:string;operationId:string;inputFingerprint:string;owner:unknown;returned?:string;stop?:"owned-process"|"provider-response"};
type Outcome={status:string;reviewId?:string|undefined;code?:string|undefined;operationId?:string|undefined};
type Attestation={codec:"resource-return-attestation/2";invocation:Invocation;outcome:Outcome};
/** Stop evidence records execution lifecycle, never an error-code allowlist.
 * Publishing after the Activity body settles prevents release during its work.
 * Missing/failed proof publication remains quarantined for evidence recovery. */
export class QualityReviewStops {
  private readonly context=new AsyncLocalStorage<Invocation>();
  private readonly completed=new Map<string,Attestation>();
  constructor(private readonly publication:RetainedPublication,private readonly reviews:{read(id:string):Promise<ReviewRecord|null>},private readonly durable=false){}
  private returnKey(c:Invocation){
    return c.activityId.startsWith("permit-")?resourceReturnKey(c):this.legacyKey(c);
  }
  private legacyKey(c:{workflowId:string;runId:string;activityName:string;operationId:string}){
    return `v3/model-returns/${sha256(Buffer.from(JSON.stringify([c.workflowId,c.runId,c.activityName,c.operationId])))}.json`;
  }
  async run<T>(context:{workflowId:string;runId:string;activityId:string},activityName:string,raw:unknown,fn:()=>Promise<T>):Promise<T>{
    if(!["interpretText","interpretImage","ocrFile"].includes(activityName))return fn();
    const task=activityName==="interpretImage"?VisionTaskSchema.parse(raw):activityName==="ocrFile"?OcrInputSchema.parse(raw):TextInputSchema.parse(raw);
    const invocation:Invocation="input" in task?{...context,activityName,operationId:task.input.operationId,inputFingerprint:visionFingerprint(task),owner:task.input.selection.observation}:
      {...context,activityName,operationId:task.operationId,inputFingerprint:task.inputFingerprint,owner:observationIdentity(task)};
    return this.context.run(invocation,async()=>{
      let result:T|undefined,failed=false;
      try{result=await fn();return result;}
      catch(error){failed=true;throw error;}
      finally{
        const out=result as Outcome|undefined;
        if(invocation.returned&&(failed||out?.status==="review")){
          const outcome:Outcome=failed?{status:"failed"}:{status:"review",reviewId:out!.reviewId,code:out!.code,...(out!.operationId?{operationId:out!.operationId}:{})};
          const saved:Attestation={codec:"resource-return-attestation/2",invocation:{...invocation},outcome},key=this.returnKey(invocation);
          try{
            if(this.durable)await publishStoppedEvidence(this.publication,key,Buffer.from(JSON.stringify(saved)),AbortSignal.timeout(65000));
            else this.completed.set(key,saved);
          }catch(error){
            console.error(JSON.stringify({event:"RESOURCE_STOP_PUBLICATION_FAILED",...context,activityName}));
            // Keep the original exception/cancellation; the verifier will fail closed.
            if(!failed)throw error;
          }
        }
      }
    });
  }
  returned(response:string|Uint8Array){const c=this.context.getStore();if(!c)throw Error("RESOURCE.STOP_CONTEXT_MISSING");c.returned=sha256(Buffer.from(response));c.stop??="provider-response";}
  closed(){const c=this.context.getStore();if(!c)throw Error("RESOURCE.STOP_CONTEXT_MISSING");c.stop="owned-process";c.returned??=sha256(Buffer.from("owned-process-close-confirmed"));}
  async verify(raw:any,signal:AbortSignal){
    const request=ResourceRequestSchema.parse(raw.request),out=raw.outcome as Outcome;
    const unknown={permitId:request.permitId,status:"unknown"};
    let review:ReviewRecord|null=null;
    if(out?.status==="review"&&typeof out.reviewId==="string"){
      review=await this.reviews.read(out.reviewId);if(!review||review.failure.code!==out.code)return unknown;
    }else if(out?.status!=="failed"||raw.activityId!==request.permitId)return unknown;
    const key=raw.activityId===request.permitId?resourceReturnKey({...request,activityId:raw.activityId,activityName:raw.activityName}):
      review?this.legacyKey({...request,activityName:raw.activityName,operationId:review.failure.operationId}):null;
    if(!key)return unknown;
    let saved:any=this.completed.get(key);
    if(!saved&&this.durable){const bytes=await this.publication.remote.read(key,65536,signal);if(bytes)saved=JSON.parse(Buffer.from(bytes).toString());}
    if(!saved)return unknown;
    const known:Invocation=saved.invocation;
    // Existing retained return attestations remain valid, but can only settle their Review.
    if(saved.codec==="model-return-attestation/1"){
      if(!review||saved.reviewId!==review.reviewId)return unknown;
    }else if(saved.codec!=="resource-return-attestation/2"||out.status==="review"&&!isDeepStrictEqual(saved.outcome,{status:"review",reviewId:out.reviewId,code:out.code,...(out.operationId?{operationId:out.operationId}:{})})||!["owned-process","provider-response"].includes(known?.stop??""))return unknown;
    if(!known?.returned||!/^[a-f0-9]{64}$/.test(known.returned)||known.workflowId!==request.workflowId||known.runId!==request.runId||known.activityName!==raw.activityName||
      (raw.activityId!==undefined&&known.activityId!==raw.activityId))return unknown;
    if(review&&(known.operationId!==review.failure.operationId||known.inputFingerprint!==review.failure.inputFingerprint||!isDeepStrictEqual(known.owner,review.observation)))return unknown;
    if(raw.activityName==="interpretText"&&out.status==="review"&&out.operationId!==known.operationId)return unknown;
    const evidenceKey=`v3/resource-stop/${request.permitId}.json`;
    const evidence={codec:"owned-resource-stop/2",request,invocation:known,outcome:out,...(review?{reviewId:review.reviewId,reviewPreserved:true}:{})};
    await publishStoppedEvidence(this.publication,evidenceKey,Buffer.from(JSON.stringify(evidence)),signal);
    return {permitId:request.permitId,status:"stopped",evidenceKey};
  }
}
