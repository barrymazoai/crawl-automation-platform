import { beforeEach,expect,it,vi } from "vitest";
const env=vi.hoisted(()=>({activities:{} as Record<string,any>,held:false,reserves:0,releases:0}));
vi.mock("@temporalio/workflow",()=>({proxyActivities:({taskQueue}:any)=>env.activities[taskQueue],workflowInfo:()=>({workflowId:"product",runId:"00000000-0000-4000-8000-000000000001"}),sleep:async()=>{},defineQuery:(n:string)=>n,setHandler:()=>{},isCancellation:()=>false,
  patched:()=>true,CancellationScope:{nonCancellable:(fn:()=>Promise<unknown>)=>fn()},
  ApplicationFailure:class extends Error{constructor(message:string,readonly type:string){super(message);}static nonRetryable(m:string,c:string){return new this(m,c);}}}));
import { GncLeasedProductWorkflow } from "./gnc-leased-workflow.js";
import { gncStreamFixture } from "./gnc-stream.fixture.js";
import { ResolveAcquiredFile } from "../../v3-acquisition/src/handoff.js";
beforeEach(()=>{env.activities={};env.held=false;env.reserves=0;env.releases=0;});
async function setup(){
  const f=await gncStreamFixture(true);
  for(const [queue,name] of Object.entries(f.route))env.activities[queue]={[name]:async(raw:unknown)=>{
    if(["captureGncProduct"].includes(name))expect(env.held).toBe(true);
    if(["ocrFile","interpretText","interpretImage"].includes(name))expect(env.held).toBe(false);
    return f.activities[name]!(raw);
  }};
  env.activities.resource={reserveResources:async(r:any)=>{if(r.needs.some((n:any)=>n.resourceId==="browser"))env.held=true;env.reserves++;return{permitId:r.permitId,status:"granted",reason:"available"};},releaseResources:async(r:any)=>{if(r.needs.some((n:any)=>n.resourceId==="browser"))env.held=false;env.releases++;return{permitId:r.permitId,status:"released",reason:"released"};}};
  env.activities.receipts={acquireSourceFile:(raw:unknown)=>new ResolveAcquiredFile(f.fileEvidence).run(raw,AbortSignal.timeout(1000))};
  env.activities[f.queues.capture!].closeGncProductPage=vi.fn(async()=>{expect(env.held).toBe(true);return{status:"closed",taskId:f.input.sourcePlan.task.capture.binding.sessionId};});
  return{...f,input:{input:f.input,start:"capture",queues:{...f.queues,acquireReceipts:"receipts"},resources:{queue:"resource",activities:{browserSession:[{resourceId:"browser",units:1}]}}}};
}
it("releases browser after durable originals and before OCR/models; receipt readback does not download twice",async()=>{
  const f=await setup();expect(await GncLeasedProductWorkflow(f.input)).toMatchObject({status:"collected"});
  expect(f.counts).toEqual({capture:1,download:2,ocr:2,text:1,vision:1});expect(env.reserves).toBe(1);expect(env.releases).toBe(1);
  expect(env.activities[f.queues.capture!].closeGncProductPage).toHaveBeenCalledOnce();
});
it("lost capture acknowledgement quarantines browser without moving next SKU",async()=>{
  const f=await setup();env.activities[f.queues.capture!].captureGncProduct=async()=>{throw Error("ack lost");};
  await expect(GncLeasedProductWorkflow(f.input)).rejects.toThrow("ack lost");expect(env.held).toBe(true);expect(env.releases).toBe(0);expect(f.counts.ocr).toBe(0);
});
it("file Review is not hidden behind a successful browser phase",async()=>{
  const f=await setup();env.activities[f.queues.acquire!]={acquireSourceFile:async(raw:any)=>({status:"review",operationId:raw.operationId,reviewId:"review-file",code:"ACQUIRE.EXECUTION_UNKNOWN",evidenceKey:"proof/file.json",automaticRetry:false})};
  expect(await GncLeasedProductWorkflow(f.input)).toMatchObject({status:"review",reviewId:"review-file"});
  expect(env.held).toBe(true);expect(env.releases).toBe(0);expect(f.counts.ocr).toBe(0);expect(f.counts.vision).toBe(0);
});
it("missing lease policy rejects before source access",async()=>{
  const f=await setup();await expect(GncLeasedProductWorkflow({...f.input,resources:undefined})).rejects.toThrow("Exclusive browser phase");expect(f.counts.capture).toBe(0);
});
it("cleanup failure prevents release and model execution",async()=>{
  const f=await setup();env.activities[f.queues.capture!].closeGncProductPage=async()=>({status:"pending"});
  await expect(GncLeasedProductWorkflow(f.input)).rejects.toThrow("cleanup unconfirmed");
  expect(env.held).toBe(true);expect(f.counts.ocr).toBe(0);expect(env.releases).toBe(0);
});
it("user-control Review stops without a second browser cleanup action",async()=>{
  const f=await setup();env.activities[f.queues.capture!].captureGncProduct=async()=>({status:"review",operationId:f.input.input.sourcePlan.task.capture.operationId,reviewId:"control-review",code:"SOURCE.BROWSER_USER_CONTROL",evidenceKey:"review/control.json",automaticRetry:false});
  expect(await GncLeasedProductWorkflow(f.input)).toMatchObject({status:"review",code:"SOURCE.BROWSER_USER_CONTROL"});
  expect(env.activities[f.queues.capture!].closeGncProductPage).not.toHaveBeenCalled();expect(env.releases).toBe(0);
});
it("browser and downstream model gates share one permit sequence",async()=>{
  const f=await setup(),requests=new Set<string>(),reserve=env.activities.resource.reserveResources;
  env.activities.resource.reserveResources=async(r:any)=>{expect(requests.has(r.permitId)).toBe(false);requests.add(r.permitId);return reserve(r);};
  const resources={...f.input.resources,activities:{...f.input.resources.activities,interpretText:[{resourceId:"model",units:1}],interpretImage:[{resourceId:"model",units:1}]}};
  expect(await GncLeasedProductWorkflow({...f.input,resources})).toMatchObject({status:"collected"});expect(requests.size).toBe(3);
});
