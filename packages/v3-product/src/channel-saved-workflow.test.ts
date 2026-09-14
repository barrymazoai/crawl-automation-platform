import { beforeEach, expect, it, vi } from "vitest";
const runtime=vi.hoisted(()=>({skipPage:true,activities:{} as Record<string,Record<string,(raw:any)=>Promise<any>>>,handlers:{} as Record<string,(raw:any)=>void>}));
vi.mock("@temporalio/workflow",()=>({proxyActivities:({taskQueue}:{taskQueue:string})=>runtime.activities[taskQueue],
  patched:(id:string)=>id==="channel-complete-image-skip-page-v1"?runtime.skipPage:true,
  defineSignal:(name:string)=>name,setHandler:(name:string,fn:(raw:any)=>void)=>{runtime.handlers[name]=fn;},
  condition:async(predicate:()=>boolean)=>{await vi.waitFor(()=>expect(predicate()).toBe(true),{timeout:15000,interval:5});},
  isCancellation:(e:unknown)=>e instanceof Error&&e.message==="cancelled",
  ApplicationFailure:class extends Error{constructor(message:string,readonly type?:string){super(message);}static nonRetryable(message:string,type?:string){return new this(message,type);}}}));
import { ApplicationFailure } from "@temporalio/workflow";
import { ChannelSavedLabelWorkflow } from "./channel-saved-workflow.js";
import { ChannelStreamingLabelWorkflow } from "./channel-stream-workflow.js";
import { channelSavedFixture } from "./channel-saved.fixture.js";
beforeEach(()=>{runtime.activities={};runtime.handlers={};runtime.skipPage=true;});
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

it("single label stops OCR and vision after the first complete image, preserves skipped originals and replay",async()=>{
 const f=await setup();f.input.evidencePolicy="label-image-first/5";f.nonmatch.clear();
 expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"collected"});
 expect(f.counts).toMatchObject({ocr:1,vision:1,text:0});
 const record=[...f.collected.values()][0]!;expect(record.provenance.filter(p=>p.kind==="image")).toHaveLength(1);
 const decision=JSON.parse(Buffer.from((await f.remote.read(`v3/channel-labels/${f.input.operationId}/selection.json`,100000))!).toString());
 expect(decision.decisions).toContainEqual({id:"image-1",reason:"complete_label_already_selected"});
 const counts={...f.counts};expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"collected"});expect(f.counts).toEqual(counts);
});
it("single label tries the next image when a registered candidate is incomplete",async()=>{
 const f=await setup();f.input.evidencePolicy="label-image-first/5";f.nonmatch.clear();
 const original=f.activities.interpretImage!,complete=structuredClone(f.imageCandidate.value);let n=0;
 f.activities.interpretImage=async raw=>{f.imageCandidate.value=structuredClone(complete);if(n++===0){f.imageCandidate.value.formula=null;f.imageCandidate.value.formulaComplete=false;}return original(raw);};
 expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"collected"});expect(f.counts).toMatchObject({ocr:2,vision:2});
 expect([...f.collected.values()][0]!.provenance.filter(p=>p.kind==="image").map(p=>p.id)).toEqual(["image-1"]);
});
it("single label cannot use an unverified image receipt as completeness proof",async()=>{
 const f=await setup();f.input.evidencePolicy="label-image-first/5";
 f.activities.interpretImage=async(raw:any)=>({status:"registered",operationId:raw.input.operationId});
 expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"review"});expect(f.collected.size).toBe(0);expect(f.counts.vision).toBe(0);
});
it("single label rejects a forged selection of an unprocessed image",async()=>{
 const f=await setup();f.input.evidencePolicy="label-image-first/5";
 await expect(f.bridge.singleManifest({input:f.input,selectedImageId:"image-1",states:f.manifest.sources.map(s=>({id:s.id,status:"registered"}))},new AbortController().signal)).rejects.toThrow();
 expect(f.collected.size).toBe(0);
});
it("single label stream still waits for every original and page closure after model success",async()=>{
 const f=await setup();f.input.evidencePolicy="label-image-first/5";f.nonmatch.clear();const sources=f.manifest.sources.filter(s=>s.kind==="file-image"),run=ChannelStreamingLabelWorkflow(f.entry);
 const first=await f.activities.acquireSourceFile!(sources[0]!.plan.acquire);runtime.handlers.channelSourceReady!({operationId:f.input.operationId,sourceId:sources[0]!.id,file:first.file});
 await vi.waitFor(()=>expect(f.counts.vision).toBe(1),{timeout:10000});expect(f.collected.size).toBe(0);
 const second=await f.activities.acquireSourceFile!(sources[1]!.plan.acquire);runtime.handlers.channelSourceReady!({operationId:f.input.operationId,sourceId:sources[1]!.id,file:second.file});
 runtime.handlers.channelStreamSealed!({operationId:f.input.operationId,status:"closed"});expect(await run).toMatchObject({status:"collected"});expect(f.counts.ocr).toBe(1);expect(f.counts.vision).toBe(1);
});

it("single label falls back to complete page text if all images fail the keyword screen",async()=>{
 const f=await setup();f.input.evidencePolicy="label-image-first/5";for(const image of f.manifest.sources)if(image.kind==="file-image")f.nonmatch.add(image.plan.imageId);
 expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"collected"});expect(f.counts.vision).toBe(0);
 expect([...f.collected.values()][0]!.warnings).toContainEqual({id:f.input.operationId,code:"LABEL_PRODUCT.COMPLETE_TEXT_FALLBACK"});
});
it("single label keeps missing later originals blocking even after complete first image",async()=>{
 const f=await setup();f.input.evidencePolicy="label-image-first/5";const source=f.manifest.sources.find(s=>s.kind==="file-image")!,run=ChannelStreamingLabelWorkflow(f.entry);
 const file=await f.activities.acquireSourceFile!((source as any).plan.acquire);runtime.handlers.channelSourceReady!({operationId:f.input.operationId,sourceId:source.id,file:file.file});
 await vi.waitFor(()=>expect(f.counts.vision).toBe(1),{timeout:10000});runtime.handlers.channelStreamSealed!({operationId:f.input.operationId,status:"failed"});
 expect(await run).toMatchObject({status:"review"});expect(f.collected.size).toBe(0);expect(f.counts.vision).toBe(1);
});
it("single manifest checks independent original files together and drains them before reporting a missing file",async()=>{
 const f=await setup();f.input.evidencePolicy="label-image-first/5";f.nonmatch.clear();
 expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"collected"});
 const selection=JSON.parse(Buffer.from((await f.remote.read(`v3/channel-labels/${f.input.operationId}/selection.json`,100000))!).toString());
 const releases:Array<(v:boolean)=>void>=[];
 (f.bridge as any).inspection.file=()=>new Promise<boolean>(resolve=>{releases.push(resolve);});
 let settled=false;
 const check=f.bridge.singleManifest(selection.request,new AbortController().signal).then(()=>{settled=true;return null;},error=>{settled=true;return error;});
 await vi.waitFor(()=>expect(releases).toHaveLength(2));
 releases[0]!(false);await Promise.resolve();expect(settled).toBe(false);
 releases[1]!(true);expect((await check)?.message).toBe("CHANNEL.LABEL_FILE_UNVERIFIED");
});

it("single label retries another image after a verified executed quality Review, preserving that Review",async()=>{
 const f=await setup();f.input.evidencePolicy="label-image-first/5";f.nonmatch.clear();const complete=structuredClone(f.imageCandidate.value),original=f.activities.interpretImage!;let n=0;
 f.activities.interpretImage=async raw=>{f.imageCandidate.value=structuredClone(complete);if(n++===0)f.imageCandidate.value.formulaComplete=false;return original(raw);};
 expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"collected"});expect(f.counts.vision).toBe(2);
 const decision=JSON.parse(Buffer.from((await f.remote.read(`v3/channel-labels/${f.input.operationId}/selection.json`,100000))!).toString());
 const prior=decision.decisions.find((d:any)=>d.id==="image-0");expect(prior.state.status).toBe("review");expect(await f.reviews.read(prior.state.reviewId)).not.toBeNull();
});

it("old histories retain their page interpretation command when the skip patch is absent",async()=>{
 const f=await setup();f.input.evidencePolicy="label-image-first/5";f.nonmatch.clear();runtime.skipPage=false;
 expect(await ChannelSavedLabelWorkflow(f.entry)).toMatchObject({status:"collected"});expect(f.counts.text).toBe(1);
});
it("a page cannot be skipped without a verified complete image",async()=>{
 const f=await setup();f.input.evidencePolicy="label-image-first/5";
 await expect(f.bridge.singleManifest({input:f.input,selectedImageId:null,states:f.manifest.sources.map(s=>({id:s.id,status:"not_started"}))},new AbortController().signal)).rejects.toThrow();
});
