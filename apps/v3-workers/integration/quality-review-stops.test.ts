import { expect,it,vi } from "vitest";
import { RetainedPublication,sha256 } from "@crawl-automation/v3-artifacts";
import { fixture } from "../../../packages/v3-text/src/testing.fixture.js";
import { QualityReviewStops } from "./quality-review-stops.js";
function setup(durable=false){
 const f=fixture(),context={workflowId:"workflow-1",runId:"00000000-0000-4000-8000-000000000001",activityId:"activity-1"};
 const review:any={reviewId:"review-1",observation:f.owner,failure:{operationId:f.input.operationId,inputFingerprint:f.input.inputFingerprint,code:"TEXT.LABEL_GROUP_EMPTY",executionFact:"executed"}};
 const stops=new QualityReviewStops(new RetainedPublication(f.local,f.remote),{read:async()=>review},durable);
 const outcome={status:"review",reviewId:review.reviewId,operationId:f.input.operationId,code:review.failure.code};
 const request={permitId:"permit-1",workflowId:context.workflowId,runId:context.runId,needs:[{resourceId:"model",units:1}]};
 return{...f,stops,context,review,outcome,request,verify:()=>stops.verify({request,activityName:"interpretText",outcome},AbortSignal.timeout(1000))};
}
it("persists exact owner/Review stop proof only after provider return and Activity completion",async()=>{
 const f=setup();await f.stops.run(f.context,"interpretText",f.input,async()=>{f.stops.returned("response");expect((await f.verify()).status).toBe("unknown");return f.outcome;});
 expect((await f.verify()).status).toBe("stopped");expect(f.remote.data.has("v3/resource-stop/permit-1.json")).toBe(true);
});
it("a separate cold verifier releases only the attested operation without calling the provider",async()=>{
 const f=setup(true);
 await f.stops.run(f.context,"interpretText",f.input,async()=>{f.stops.returned("response");return f.outcome;});
 const verifier=new QualityReviewStops(new RetainedPublication(f.local,f.remote),{read:async()=>f.review},true);
 expect((await verifier.verify({request:f.request,activityName:"interpretText",outcome:f.outcome},AbortSignal.timeout(1000))).status).toBe("stopped");
});
it.each([true,false])("citation Review requires an actual provider stop attestation (returned=%s)",async returned=>{
 const f=setup(true);f.review.failure.code=f.outcome.code="TEXT.CITATION_INVALID";
 await f.stops.run(f.context,"interpretText",f.input,async()=>{if(returned)f.stops.returned("invalid citation response");return f.outcome;});
 const verifier=new QualityReviewStops(new RetainedPublication(f.local,f.remote),{read:async()=>f.review},true);
 expect((await verifier.verify({request:f.request,activityName:"interpretText",outcome:f.outcome},AbortSignal.timeout(1000))).status).toBe(returned?"stopped":"unknown");
 expect(f.review.failure.code).toBe("TEXT.CITATION_INVALID");
});
it.each(["no-return","throws","foreign-operation","foreign-run"])("cold verifier rejects %s",async mode=>{
 const f=setup(true);
 if(mode==="handoff")f.review.failure.code=f.outcome.code="TEXT.HANDOFF_UNKNOWN";
 if(mode==="unknown")f.review.failure.executionFact="unknown";
 try{await f.stops.run(f.context,"interpretText",f.input,async()=>{if(mode!=="no-return")f.stops.returned("response");if(mode==="throws")throw Error();return f.outcome;});}catch{}
 if(mode==="foreign-operation")f.review.failure.operationId="different";
 if(mode==="foreign-run")f.request.runId="00000000-0000-4000-8000-000000000002";
 const verifier=new QualityReviewStops(new RetainedPublication(f.local,f.remote),{read:async()=>f.review},true);
 expect((await verifier.verify({request:f.request,activityName:"interpretText",outcome:f.outcome},AbortSignal.timeout(1000))).status).toBe("unknown");
});
it.each(["no-return","activity-throws","foreign-owner","foreign-input"])("quarantines %s",async mode=>{
 const f=setup();try{await f.stops.run(f.context,"interpretText",f.input,async()=>{if(mode!=="no-return")f.stops.returned("response");if(mode==="activity-throws")throw Error();return f.outcome;});}catch{}
 if(mode==="foreign-owner")f.request.workflowId="different";
 if(mode==="foreign-input")f.review.failure.inputFingerprint="b".repeat(64);
 if(mode==="unknown-execution")f.review.failure.executionFact="unknown";
 if(mode==="handoff")f.review.failure.code=f.outcome.code="TEXT.HANDOFF_UNKNOWN";
 expect((await f.verify()).status).toBe("unknown");expect(f.remote.data.has("v3/resource-stop/permit-1.json")).toBe(false);
});

it('resumes a stop proof whose claim exists after a failed upload, without another model call',async()=>{
 const f=setup(true),model=vi.fn(async()=>{f.stops.returned('response');return f.outcome;}),log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  await f.stops.run(f.context,'interpretText',f.input,model);
  const key='v3/resource-stop/permit-1.json',create=f.remote.create.bind(f.remote);let failed=true;
  f.remote.create=async(k,b)=>{if(k===key&&failed)throw Error('synthetic upload unavailable');return create(k,b);};
  await expect(f.verify()).rejects.toThrow('RESOURCE.STOP_PUBLICATION_UNAVAILABLE');
  expect(f.remote.data.has(key)).toBe(false);const claimKey='v3/publication-claims/'+sha256(Buffer.from(key))+'.json',claim=f.remote.data.get(claimKey);expect(claim).toBeDefined();
  failed=false;const verifier=new QualityReviewStops(new RetainedPublication(f.local,f.remote),{read:async()=>f.review},true);
  expect(await verifier.verify({request:f.request,activityName:'interpretText',outcome:f.outcome},AbortSignal.timeout(3000))).toMatchObject({status:'stopped'});
  expect(f.remote.data.get(claimKey)).toEqual(claim);expect(model).toHaveBeenCalledOnce();expect(f.review.failure.code).toBe('TEXT.LABEL_GROUP_EMPTY');
 }finally{log.mockRestore();}
});
it('reconciles lost conditional PUT replies by exact readback',async()=>{
 const f=setup(true),log=vi.spyOn(console,'error').mockImplementation(()=>{});f.remote.unknown=true;
 try{await f.stops.run(f.context,'interpretText',f.input,async()=>{f.stops.returned('response');return f.outcome;});
  expect(await f.verify()).toMatchObject({status:'stopped'});expect(f.remote.data.has('v3/resource-stop/permit-1.json')).toBe(true);
 }finally{log.mockRestore();}
});
it('never replaces a conflicting publication claim or restarts the model',async()=>{
 const f=setup(true),log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{await f.stops.run(f.context,'interpretText',f.input,async()=>{f.stops.returned('response');return f.outcome;});
  const key='v3/resource-stop/permit-1.json',claimKey='v3/publication-claims/'+sha256(Buffer.from(key))+'.json',foreign=Buffer.from(JSON.stringify({key,sha256:'0'.repeat(64),nonce:'00000000-0000-4000-8000-000000000001'}));
  f.remote.data.set(claimKey,foreign);await expect(f.verify()).rejects.toThrow('RESOURCE.STOP_EVIDENCE_CONFLICT');expect(f.remote.data.get(claimKey)).toBe(foreign);expect(f.remote.data.has(key)).toBe(false);
 }finally{log.mockRestore();}
});

it.each(['OCR.EMPTY','TEXT.HANDOFF_UNKNOWN','TEXT.UNKNOWN_FUTURE_CODE'])('a confirmed return releases independently of error code or executionFact: %s',async code=>{
 const f=setup(true);f.review.failure.code=f.outcome.code=code;f.review.failure.executionFact='unknown';
 await f.stops.run(f.context,'interpretText',f.input,async()=>{f.stops.returned('response');return f.outcome;});
 expect(await f.verify()).toMatchObject({status:'stopped'});expect(f.review.failure.code).toBe(code);
});
it.each(['throw','cancel'])('cold verifier can confirm Activity %s after owned process close without a Review receipt',async mode=>{
 const f=setup(true),context={...f.context,activityId:f.request.permitId},error=Error(mode);
 await expect(f.stops.run(context,'interpretText',f.input,async()=>{f.stops.closed();throw error;})).rejects.toBe(error);
 const verifier=new QualityReviewStops(new RetainedPublication(f.local,f.remote),{read:async()=>{throw Error('no Review lookup');}},true);
 expect(await verifier.verify({request:f.request,activityId:f.request.permitId,activityName:'interpretText',outcome:{status:'failed'}},AbortSignal.timeout(1000))).toMatchObject({status:'stopped'});
 expect(await verifier.verify({request:{...f.request,permitId:'other'},activityId:'other',activityName:'interpretText',outcome:{status:'failed'}},AbortSignal.timeout(1000))).toMatchObject({status:'unknown'});
});
it('a returned provider does not authorize release while the Activity body is still running',async()=>{
 const f=setup(true),context={...f.context,activityId:f.request.permitId};
 await f.stops.run(context,'interpretText',f.input,async()=>{
  f.stops.closed();expect(await f.stops.verify({request:f.request,activityId:f.request.permitId,activityName:'interpretText',outcome:{status:'failed'}},AbortSignal.timeout(1000))).toMatchObject({status:'unknown'});
  return f.outcome;
 });
});
