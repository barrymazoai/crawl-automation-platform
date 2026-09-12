import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { ResourceRequestSchema, TextInputSchema, VisionTaskSchema, observationIdentity, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { visionFingerprint } from "@crawl-automation/v3-vision";
import { RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
type Invocation={workflowId:string;runId:string;activityId:string;activityName:string;operationId:string;inputFingerprint:string;owner:unknown;returned?:string};
// Citation validation runs after provider return just like label validation.
// This only authorizes a stop proof; the invalid result remains in Review.
const qualityFailure=(code:string)=>/^(TEXT|VISION)\.LABEL_[A-Z_]+$/.test(code)||code==="TEXT.CITATION_INVALID";
/** No inference from Review status: returned() is
 * called only AFTER the owned provider has returned AND confirmed process close.
 * Durable mode publishes a return attestation for a separate verifier process. */
export class QualityReviewStops {
  private readonly context=new AsyncLocalStorage<Invocation>();
  private readonly completed=new Map<string,Invocation>();
  constructor(private readonly publication:RetainedPublication,private readonly reviews:{read(id:string):Promise<ReviewRecord|null>},private readonly durable=false){}
  private returnKey(c:{workflowId:string;runId:string;activityName:string;operationId:string}){
    return `v3/model-returns/${sha256(Buffer.from(JSON.stringify([c.workflowId,c.runId,c.activityName,c.operationId])))}.json`;
  }
  async run<T>(context:{workflowId:string;runId:string;activityId:string},activityName:string,raw:unknown,fn:()=>Promise<T>):Promise<T>{
    if(!["interpretText","interpretImage"].includes(activityName))return fn();
    const task=activityName==="interpretText"?TextInputSchema.parse(raw):VisionTaskSchema.parse(raw);
    const invocation:Invocation="source" in task?{...context,activityName,operationId:task.operationId,inputFingerprint:task.inputFingerprint,owner:observationIdentity(task)}:
      {...context,activityName,operationId:task.input.operationId,inputFingerprint:visionFingerprint(task),owner:task.input.selection.observation};
    return this.context.run(invocation,async()=>{
      const result=await fn();
      if(invocation.returned&&!this.durable)this.completed.set(invocation.operationId,invocation);
      const out=result as {status?:string;reviewId?:string;code?:string};
      if(this.durable&&invocation.returned&&out?.status==="review"&&out.reviewId){
        const review=await this.reviews.read(out.reviewId);
        if(review&&review.failure.code===out.code&&qualityFailure(review.failure.code)&&review.failure.executionFact==="executed"&&
          review.failure.operationId===invocation.operationId&&review.failure.inputFingerprint===invocation.inputFingerprint&&isDeepStrictEqual(review.observation,invocation.owner))
          await this.publication.publish(this.returnKey(invocation),Buffer.from(JSON.stringify({codec:"model-return-attestation/1",invocation,reviewId:out.reviewId})),"application/json",AbortSignal.timeout(10000));
      }
      return result;
    });
  }
  returned(response:string){const current=this.context.getStore();if(!current)throw Error("RESOURCE.STOP_CONTEXT_MISSING");current.returned=sha256(Buffer.from(response));}
  async verify(raw:any,signal:AbortSignal){
    const request=ResourceRequestSchema.parse(raw.request),out=raw.outcome;
    const unknown={permitId:request.permitId,status:"unknown"};
    if(out?.status!=="review"||typeof out.reviewId!=="string")return unknown;
    const review=await this.reviews.read(out.reviewId);if(!review||review.failure.code!==out.code)return unknown;
    let known=this.completed.get(review.failure.operationId);
    if(!known&&this.durable){
      const bytes=await this.publication.remote.read(this.returnKey({...request,activityName:raw.activityName,operationId:review.failure.operationId}),65536,signal);
      if(bytes){const saved=JSON.parse(Buffer.from(bytes).toString());
        if(saved.codec==="model-return-attestation/1"&&saved.reviewId===review.reviewId)known=saved.invocation;
      }
    }
    if(!known?.returned||!/^[a-f0-9]{64}$/.test(known.returned)||known.operationId!==review.failure.operationId||known.workflowId!==request.workflowId||known.runId!==request.runId||known.activityName!==raw.activityName||
      known.inputFingerprint!==review.failure.inputFingerprint||!isDeepStrictEqual(known.owner,review.observation))return unknown;
    if(raw.activityName==="interpretText"&&out.operationId!==known.operationId)return unknown;
    // Restrict this proof to quality validation; unknown executions and handoff
    // failures continue through the existing separate evidence recovery path.
    if(!qualityFailure(review.failure.code)||review.failure.executionFact!=="executed")return unknown;
    const key=`v3/resource-stop/${request.permitId}.json`,evidence={codec:"owned-model-review-stop/1",request,invocation:known,reviewId:review.reviewId,reviewPreserved:true};
    await this.publication.publish(key,Buffer.from(JSON.stringify(evidence)),"application/json",signal);
    return {permitId:request.permitId,status:"stopped",evidenceKey:key};
  }
}
