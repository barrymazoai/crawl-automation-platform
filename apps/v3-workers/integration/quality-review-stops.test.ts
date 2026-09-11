import { expect,it } from "vitest";
import { RetainedPublication } from "@crawl-automation/v3-artifacts";
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
it.each(["no-return","throws","foreign-operation","foreign-run","handoff","unknown"])("cold verifier rejects %s",async mode=>{
 const f=setup(true);
 if(mode==="handoff")f.review.failure.code=f.outcome.code="TEXT.HANDOFF_UNKNOWN";
 if(mode==="unknown")f.review.failure.executionFact="unknown";
 try{await f.stops.run(f.context,"interpretText",f.input,async()=>{if(mode!=="no-return")f.stops.returned("response");if(mode==="throws")throw Error();return f.outcome;});}catch{}
 if(mode==="foreign-operation")f.review.failure.operationId="different";
 if(mode==="foreign-run")f.request.runId="00000000-0000-4000-8000-000000000002";
 const verifier=new QualityReviewStops(new RetainedPublication(f.local,f.remote),{read:async()=>f.review},true);
 expect((await verifier.verify({request:f.request,activityName:"interpretText",outcome:f.outcome},AbortSignal.timeout(1000))).status).toBe("unknown");
});
it.each(["no-return","activity-throws","foreign-owner","foreign-input","unknown-execution","handoff"])("quarantines %s",async mode=>{
 const f=setup();try{await f.stops.run(f.context,"interpretText",f.input,async()=>{if(mode!=="no-return")f.stops.returned("response");if(mode==="activity-throws")throw Error();return f.outcome;});}catch{}
 if(mode==="foreign-owner")f.request.workflowId="different";
 if(mode==="foreign-input")f.review.failure.inputFingerprint="b".repeat(64);
 if(mode==="unknown-execution")f.review.failure.executionFact="unknown";
 if(mode==="handoff")f.review.failure.code=f.outcome.code="TEXT.HANDOFF_UNKNOWN";
 expect((await f.verify()).status).toBe("unknown");expect(f.remote.data.has("v3/resource-stop/permit-1.json")).toBe(false);
});
