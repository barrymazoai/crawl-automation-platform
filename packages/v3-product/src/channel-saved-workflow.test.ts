import { beforeEach, expect, it, vi } from "vitest";
const runtime=vi.hoisted(()=>({activities:{} as Record<string,Record<string,(raw:any)=>Promise<any>>>,handlers:{} as Record<string,(raw:any)=>void>}));
vi.mock("@temporalio/workflow",()=>({proxyActivities:({taskQueue}:{taskQueue:string})=>runtime.activities[taskQueue],
  patched:()=>true,
  defineSignal:(name:string)=>name,setHandler:(name:string,fn:(raw:any)=>void)=>{runtime.handlers[name]=fn;},
  condition:async(predicate:()=>boolean)=>{await vi.waitFor(()=>expect(predicate()).toBe(true),{timeout:15000,interval:5});},
  isCancellation:(e:unknown)=>e instanceof Error&&e.message==="cancelled",
  ApplicationFailure:class extends Error{constructor(message:string,readonly type?:string){super(message);}static nonRetryable(message:string,type?:string){return new this(message,type);}}}));
import { ApplicationFailure } from "@temporalio/workflow";
import { ChannelSavedLabelWorkflow } from "./channel-saved-workflow.js";
import { ChannelStreamingLabelWorkflow } from "./channel-stream-workflow.js";
import { channelSavedFixture } from "./channel-saved.fixture.js";
beforeEach(()=>{runtime.activities={};runtime.handlers={};});
async function setup(){const f=await channelSavedFixture();runtime.activities=f.activityQueues;return f;}

it("saved evidence advances without capture/download; label protocol collects and replay does not call providers",async()=>{
  const f=await setup(),before={...f.counts};
  expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"collected"});
  expect(f.counts).toEqual({...before,ocr:2,text:1,vision:1});
  expect([...f.textRegistry.data.values()][0]!.input.resultSchemaVersion).toBe(3);
  const counts={...f.counts},puts=f.remote.writes;
  expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"collected"});
  expect(f.counts).toEqual(counts);expect(f.remote.writes).toBe(puts);
});
it("slow page model does not block independent OCR and matched-image model",async()=>{
  const f=await setup(),original=f.activities.interpretText!;let release!:()=>void;
  const wait=new Promise<void>(r=>{release=r;});f.activities.interpretText=async raw=>{await wait;return original(raw);};
  const run=ChannelSavedLabelWorkflow(f.entry);
  await vi.waitFor(()=>expect(f.visionRecords.size).toBe(1),{timeout:10000});
  expect(f.counts.text).toBe(0);expect(f.collected.size).toBe(0);release();
  expect(await run).toMatchObject({status:"collected"});
});
it("a waiting Swanson core queue does not block independent image work, and core failure remains Review",async()=>{
  const f=await setup();let release!:()=>void;
  const wait=new Promise<void>(r=>{release=r;});
  runtime.activities.core={prepareSwansonLabelCore:async()=>{await wait;throw Error("core unavailable");}};
  const run=ChannelSavedLabelWorkflow({input:{...f.input,corePolicy:"swanson-label-core/1"},queues:{...f.entry.queues,core:"core"}});
  await vi.waitFor(()=>expect(f.visionRecords.size).toBe(1),{timeout:10000});
  expect(f.counts.text).toBe(0);expect(f.counts.ocr).toBe(2);expect(f.collected.size).toBe(0);release();
  expect(await run).toMatchObject({status:"review",code:"CHANNEL.LABEL_PREPARATION_UNVERIFIED"});
});
it("lost OCR completion acknowledgement reads evidence without a second OCR invocation",async()=>{
  const f=await setup(),original=f.activities.ocrFile!;
  f.activities.ocrFile=async raw=>{await original(raw);throw Error("ack lost");};
  expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"collected"});expect(f.counts.ocr).toBe(2);
});
it("unknown source handoff cannot collect but other sources still finish",async()=>{
  const f=await setup(),original=f.activities.prepareChannelLabelSource;
  f.activities.prepareChannelLabelSource=async(raw:any)=>{const r=await original(raw);if(raw.sourceId==="image-0")throw Error("ack lost");return r;};
  expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"review"});expect(f.counts.text).toBe(1);expect(f.counts.vision).toBe(0);
});
it("forged per-source observation never triggers the image model",async()=>{
  const f=await setup(),original=f.activities.prepareChannelLabelSource;
  f.activities.prepareChannelLabelSource=async(raw:any)=>{const r=await original(raw);if(r.status==="prepared"&&r.source.kind==="image")r.source.task.input.selection.observation.listingId="foreign";return r;};
  expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"review"});expect(f.counts.vision).toBe(0);
});
it("missing final coverage is rejected before collection",async()=>{
  const f=await setup(),original=f.activities.prepareChannelLabelManifest;
  f.activities.prepareChannelLabelManifest=async raw=>({...await original(raw),skipped:[]});
  await expect(ChannelSavedLabelWorkflow(f.entry)).rejects.toThrow("Channel source identity conflict");expect(f.collected.size).toBe(0);
});
it("final preparation failure produces passive categorized Review",async()=>{
  const f=await setup();f.activities.prepareChannelLabelManifest=async()=>{throw Error("unavailable");};
  expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"review",automaticRetry:false,code:"CHANNEL.LABEL_PREPARATION_UNVERIFIED"});
});
it("cancellation is not converted into a success or an automatic retry",async()=>{
  const f=await setup();f.activities.loadChannelLabelPlan=async()=>{throw Error("cancelled");};
  await expect(ChannelSavedLabelWorkflow(f.entry)).rejects.toThrow("cancelled");expect(f.counts.ocr).toBe(0);
});
it("admission timeout before OCR does not manufacture missing OCR receipts",async()=>{
  const f=await setup(),receipt=vi.fn(f.activities.resolveOcrReceipt!);f.activities.resolveOcrReceipt=receipt;
  f.activities.ocrFile=async()=>{throw ApplicationFailure.nonRetryable("No provider started","RESOURCE.WAIT_LIMIT");};
  expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"review",code:"CHANNEL.DEPENDENCY_UNAVAILABLE"});
  expect(receipt).not.toHaveBeenCalled();expect(f.counts.ocr).toBe(0);expect(f.counts.text).toBe(1);
});
it("admission timeout before text does not reconcile a model that never ran",async()=>{
  const f=await setup(),receipt=vi.fn(f.activities.resolveTextReceipt!);f.activities.resolveTextReceipt=receipt;
  f.activities.interpretText=async()=>{throw ApplicationFailure.nonRetryable("No provider started","RESOURCE.WAIT_LIMIT");};
  expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"review",code:"CHANNEL.DEPENDENCY_UNAVAILABLE"});
  expect(receipt).not.toHaveBeenCalled();expect(f.counts.text).toBe(0);expect(f.counts.vision).toBe(1);
});
it("stream: text and the first durable file advance while a sibling waits; duplicate hints do not duplicate OCR; collection waits for closure",async()=>{
  const f=await setup(),sources=f.manifest.sources.filter(s=>s.kind==="file-image"),run=ChannelStreamingLabelWorkflow(f.entry);
  await vi.waitFor(()=>expect(f.counts.text).toBe(1),{timeout:10000});expect(f.counts.ocr).toBe(0);
  const first=await f.activities.acquireSourceFile!(sources[0]!.plan.acquire),hint={operationId:f.input.operationId,sourceId:sources[0]!.id,file:first.file};
  runtime.handlers.channelSourceReady!(hint);runtime.handlers.channelSourceReady!(hint);
  await vi.waitFor(()=>expect(f.visionRecords.size).toBe(1),{timeout:10000});expect(f.counts.ocr).toBe(1);expect(f.collected.size).toBe(0);
  const second=await f.activities.acquireSourceFile!(sources[1]!.plan.acquire);runtime.handlers.channelSourceReady!({operationId:f.input.operationId,sourceId:sources[1]!.id,file:second.file});
  await vi.waitFor(()=>expect(f.counts.ocr).toBe(2),{timeout:10000});expect(f.collected.size).toBe(0);
  runtime.handlers.channelStreamSealed!({operationId:f.input.operationId,status:"closed"});expect(await run).toMatchObject({status:"collected"});expect(f.counts.ocr).toBe(2);
});
it("stream: later acquisition failure keeps completed sibling evidence and cannot collect partial coverage",async()=>{
  const f=await setup(),source=f.manifest.sources.find(s=>s.kind==="file-image")!,run=ChannelStreamingLabelWorkflow(f.entry);
  const receipt=await f.activities.acquireSourceFile!((source as any).plan.acquire);
  runtime.handlers.channelSourceReady!({operationId:f.input.operationId,sourceId:source.id,file:receipt.file});
  await vi.waitFor(()=>expect(f.visionRecords.size).toBe(1),{timeout:10000});runtime.handlers.channelStreamSealed!({operationId:f.input.operationId,status:"failed"});
  expect(await run).toMatchObject({status:"review",code:"CHANNEL.LABEL_PREPARATION_UNVERIFIED"});expect(f.counts.ocr).toBe(1);expect(f.visionRecords.size).toBe(1);expect(f.collected.size).toBe(0);
});
it.each(["foreign-owner","foreign-file","conflicting-duplicate"])("stream: %s cannot authorize a source or collection",async mode=>{
  const f=await setup(),source=f.manifest.sources.find(s=>s.kind==="file-image")!,run=ChannelStreamingLabelWorkflow(f.entry);
  const receipt=await f.activities.acquireSourceFile!((source as any).plan.acquire),file={...receipt.file};
  const hint={operationId:f.input.operationId,sourceId:source.id,file};
  if(mode==="foreign-owner")file.observationId="other";
  if(mode==="foreign-file")file.artifactId="other";
  if(mode==="conflicting-duplicate")runtime.handlers.channelSourceReady!({...hint,file:{...file,sha256:"a".repeat(64)}});
  runtime.handlers.channelSourceReady!(hint);runtime.handlers.channelStreamSealed!({operationId:f.input.operationId,status:"failed"});
  expect(await run).toMatchObject({status:"review"});expect(f.counts.ocr).toBe(0);expect(f.collected.size).toBe(0);
});
