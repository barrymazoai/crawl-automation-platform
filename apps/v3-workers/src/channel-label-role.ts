import { join, dirname, delimiter } from "node:path";
import type pg from "pg";
import { FileCopies, ArtifactResolver, RetainedPublication, sha256, verifyBytes, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { ChannelLabelInputSchema, ReviewRecordSchema, TextOutputSchema, TextCandidateV3Schema, VisionTaskSchema } from "@crawl-automation/v3-contracts";
import { ChannelProductPlans, ChannelLabelPlans } from "@crawl-automation/v3-channels";
import { FileEvidence, PageEvidence, PreparePageModule, PreparePageText, PrepareImageOcr, PrepareSwansonLabelCore } from "@crawl-automation/v3-acquisition";
import { FileCompletionJournal, PostgresResultRegistry, OcrResultHandoff } from "@crawl-automation/v3-results";
import { OcrFileModule, OcrIntents, MultipartOcr } from "@crawl-automation/v3-ocr";
import { TextLocalStore, TextEvidence, TextHandoff, TextModule, ResolveTextReceipt, PostgresTextRegistry, CodexTextProvider } from "@crawl-automation/v3-text";
import { RegisteredOcrEvidence, KeywordPublication, VisionHandoff, VisionModule, PostgresVisionRegistry, CodexVisionProvider, visionReviewWriter, assertLabelVisionRegistrySchema } from "@crawl-automation/v3-vision";
import { PostgresReviews } from "@crawl-automation/v3-review";
import { SavedSourceEvidence, ResolveOcrReceipt, LabelProductAssembly, CollectLabelProduct, PostgresLabelCollectedProducts } from "@crawl-automation/v3-product";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";
import { QualityReviewStops } from "./quality-review-stops.js";
import {historyObservations} from "./history-observations.js";

export const channelLabelRoutes:Record<string,string[]>={
 plan:["loadChannelLabelPlan"],page:["prepareHtmlPage"],"page-text":["preparePageText"],"image-prepare":["prepareImageOcr"],
 ocr:["ocrFile"],"ocr-receipts":["resolveOcrReceipt"],keywords:["screenImageKeywords"],source:["prepareChannelLabelSource","inspectChannelLabelImage"],
 manifest:["prepareChannelLabelManifest","prepareChannelSingleLabelManifest"],text:["interpretText"],"text-receipts":["resolveTextReceipt"],vision:["interpretImage"],
 core:["prepareSwansonLabelCore"],assembly:["assembleLabelProduct"],collection:["collectLabelProduct"],review:["reviewChannelProduct"],
 resources:["reserveResources","releaseResources","verifyResourceReviewStopped"],
};

/** Fixed role factories; shared objects are created once, only when that role needs them. */
export async function channelLabelRole(o:{role:string;hostId:string;root:string;remote:ObjectStore;db:pg.Pool;resourceDb?:pg.Pool;storageId:string;
 codex?:Record<string,unknown>;ocrProvider?:ConstructorParameters<typeof MultipartOcr>[0]}){
 if(!channelLabelRoutes[o.role])throw Error("CHANNEL.ROLE_UNKNOWN");
 if(!o.hostId)throw Error("CHANNEL.HOST_REQUIRED");
 if(["text","vision"].includes(o.role)&&!o.codex)throw Error("CHANNEL.CODEX_CONFIG_REQUIRED");
 if(o.role==="ocr"&&!o.ocrProvider)throw Error("CHANNEL.OCR_CONFIG_REQUIRED");
 const {root,remote,db,storageId}=o,local=await TextLocalStore.open(join(root,"journal"));
 const reviews=new PostgresReviews(db),publication=new RetainedPublication(local,remote),stops=new QualityReviewStops(publication,reviews,true);
 const closers:Array<()=>Promise<void>>=[],checks:Array<()=>Promise<void>>=[];
 const constructed:string[]=[];
 function once<T>(name:string,create:()=>Promise<T>){let value:Promise<T>|undefined;return()=>value??=(constructed.push(name),create());}
 const copies=once("file-copies",()=>FileCopies.open(join(root,"cache")));
 const artifacts=once("artifact-resolver",async()=>new ArtifactResolver(await copies(),remote));
 const files=once("file-evidence",async()=>new FileEvidence({local,remote,copies:await copies(),reviews}));
 const pages=once("page-evidence",async()=>new PageEvidence({local,remote,reviews}));
 const registry=once("ocr-registry",async()=>new PostgresResultRegistry(db));
 const results=once("ocr-handoff",async()=>new OcrResultHandoff(storageId,await copies(),remote,await FileCompletionJournal.open(join(root,"ocr-journal")),await registry()));
 const screen=once("registered-ocr",async()=>new RegisteredOcrEvidence(await artifacts(),await results(),await registry()));
 const textEvidence=once("text-evidence",async()=>new TextEvidence(await artifacts(),await results()));
 const textHandoff=once("text-handoff",async()=>new TextHandoff(local,remote,new PostgresTextRegistry(db),await textEvidence(),storageId));
 const visionHandoff=once("vision-handoff",async()=>new VisionHandoff(local,remote,new PostgresVisionRegistry(db),storageId,async(task,s)=>{await(await screen()).verifiedText(task.input.selection,s);}));
 const core=once("label-core",async()=>new PrepareSwansonLabelCore(await artifacts(),remote));
 const saved=once("saved-source",async()=>new SavedSourceEvidence({remote,files:await files(),pages:await pages(),reviews,ocr:await registry(),screen:await screen()}));
 const labels=once("label-plans",async()=>new ChannelLabelPlans(new ChannelProductPlans(publication,await artifacts(),reviews),publication,
   async(source,s)=>(await saved()).resolve(source,{id:source.id,status:"unresolved"},s),await core(),{file:async(source,s)=>source.kind==="file-image"&&!!await(await files()).inspect(source.plan.acquire,s),image:async(source,s)=>{
     if(source.kind!=="image")throw Error("CHANNEL.LABEL_IDENTITY_CONFLICT");
     return (await(await visionHandoff()).readLabelCandidate(source.task,s)).candidate;
   },review:id=>reviews.read(id)}));
 const assembly=once("label-assembly",async()=>new LabelProductAssembly({local,remote,reviews,readSource:async(source,s)=>{
   if(source.kind==="image")return{id:source.id,kind:"image",...await(await visionHandoff()).readLabelCandidate(source.task,s)};
   const facts=await(await textHandoff()).inspect(source.task,s);
   if(!facts.artifactDurable||!facts.resultRegistered||!facts.record)throw Error("LABEL_PRODUCT.TEXT_UNVERIFIED");
   const bytes=await remote.read(facts.record.result.objectKey,524288,s);if(!bytes)throw Error("LABEL_PRODUCT.TEXT_UNVERIFIED");verifyBytes(facts.record.result,bytes,524288);
   return{id:source.id,kind:"text",record:facts.record,candidate:TextCandidateV3Schema.parse(TextOutputSchema.parse(JSON.parse(Buffer.from(bytes).toString())).candidate),fullText:(await(await textEvidence()).resolve(source.task,s)).text};
 }}));
 const activities:Record<string,(raw:any,s:AbortSignal)=>Promise<unknown>>={};
 const environment={...process.env,PATH:[dirname(process.execPath),process.env.PATH].filter(Boolean).join(delimiter)};
 try{
 switch(o.role){
 case "plan":{const m=await labels();activities.loadChannelLabelPlan=(r,s)=>m.load(r,s);break;}
 case "source":{const m=await labels();activities.prepareChannelLabelSource=(r,s)=>m.source(r,s);activities.inspectChannelLabelImage=(r,s)=>m.imageCheck(r,s);break;}
 case "manifest":{const m=await labels();activities.prepareChannelLabelManifest=(r,s)=>m.manifest(r,s);activities.prepareChannelSingleLabelManifest=(r,s)=>m.singleManifest(r,s);break;}
 case "page":{const m=new PreparePageModule(await pages());activities.prepareHtmlPage=(r,s)=>m.run(r,s);break;}
 case "page-text":{const m=new PreparePageText(await pages());activities.preparePageText=(r,s)=>m.run(r,s);break;}
 case "image-prepare":{const m=new PrepareImageOcr(await files());activities.prepareImageOcr=(r,s)=>m.run(r,s);break;}
 case "ocr":{
  const p=new MultipartOcr(o.ocrProvider!);closers.push(()=>p.close());constructed.push("ocr-provider");
  const m=new OcrFileModule({provider:p,artifacts:await artifacts(),intents:new OcrIntents(remote,o.hostId,storageId),results:await results(),reviews});
  activities.ocrFile=(r,s)=>m.run(r,s);break;
 }
 case "ocr-receipts":{const m=new ResolveOcrReceipt({results:await results(),local,reviews});activities.resolveOcrReceipt=(r,s)=>m.run(r,s);break;}
 case "keywords":{const m=await screen(),k=new KeywordPublication(local,remote);activities.screenImageKeywords=async(r,s)=>{const selected=await m.screen(r,s);return{status:selected.status,imageId:selected.image.artifactId,selection:selected,...await k.publish(selected,s)};};break;}
 case "core":{const m=await core();activities.prepareSwansonLabelCore=(r,s)=>m.run(r,s);break;}
 case "text":{
  const p=await CodexTextProvider.open(o.codex!,environment);closers.push(()=>p.close());constructed.push("text-provider");checks.push(()=>p.check(AbortSignal.timeout(30000)));
  const m=new TextModule({provider:{provider:p.provider,supported:p.supported,policy:p.policy,close:()=>p.close(),interpret:async(...args)=>{const result=await p.interpret(...args);stops.returned(result);return result;}},handoff:await textHandoff(),reviews,nodeId:o.hostId});
  activities.interpretText=(r,s)=>m.run(r,s);break;
 }
 case "text-receipts":{const m=new ResolveTextReceipt({results:await textHandoff(),local,reviews});activities.resolveTextReceipt=(r,s)=>m.run(r,s);break;}
 case "vision":{
  const meta=CodexVisionProvider.describe(o.codex!),p=await CodexVisionProvider.open(o.codex!,environment);closers.push(()=>p.close());constructed.push("vision-provider");
  checks.push(async()=>{await assertLabelVisionRegistrySchema(db,meta.extractionProtocol);await p.check(AbortSignal.timeout(30000));});
  const h=await visionHandoff(),m=new VisionModule({provider:{fingerprint:meta.configFingerprint,extractionProtocol:meta.extractionProtocol,interpret:async(...args)=>{const result=await p.interpret(...args);stops.returned(result);return result;}},store:remote,localEvidence:local,
    verifiedOcrText:async(s,a)=>(await screen()).verifiedText(s,a),resolve:async(f,a,owner)=>(await(await artifacts()).resolve(f,owner,a)).bytes});
  const record=visionReviewWriter(local,reviews);
  activities.interpretImage=async(raw,signal)=>{const task=VisionTaskSchema.parse(raw);if(task.configFingerprint!==meta.configFingerprint)throw Error("VISION.CONFIG_MISMATCH");
    if(await h.inspect(task,signal))return{status:"registered",operationId:task.input.operationId};let outcome=await m.run(task.input,signal);
    if(outcome.status!=="review"){if(outcome.replayed)outcome={...outcome,status:"review",code:"VISION.HANDOFF_PENDING"};else try{await h.complete(task,signal);return{status:"registered",operationId:task.input.operationId};}catch{outcome={...outcome,status:"review",code:"VISION.HANDOFF_PENDING"};}}
    return{status:"review",code:outcome.code,automaticRetry:false,...await record(task,outcome,AbortSignal.timeout(10000))};};break;
 }
 case "assembly":{const m=await assembly();activities.assembleLabelProduct=(r,s)=>m.run(r,s);break;}
 case "collection":{const m=new CollectLabelProduct({local,remote,reviews,assembly:await assembly(),registry:new PostgresLabelCollectedProducts(db)}),history=historyObservations(db,remote);await history?.check();activities.collectLabelProduct=async(r,s)=>{const result=await m.run(r,s);if(result.status==="collected")await history?.attempt("collected",result.operationId,s);return result;};break;}
 case "resources":{const m=new PostgresResourceAdmission(o.resourceDb??db);activities.reserveResources=r=>m.reserve(r);activities.releaseResources=r=>m.release(r);activities.verifyResourceReviewStopped=(r,s)=>stops.verify(r,s);break;}
 case "review":{activities.reviewChannelProduct=async(raw,s)=>{
   if(!["CHANNEL.LABEL_PREPARATION_UNVERIFIED","CHANNEL.DEPENDENCY_UNAVAILABLE"].includes(raw.code))throw Error("CHANNEL.REVIEW_CODE_REJECTED");
   const input=ChannelLabelInputSchema.parse(raw.input),owner=input.sourcePlan.owner,fp=sha256(Buffer.from(JSON.stringify(input))),id=`chl-review-${fp}`,key=`v3/channel-labels/${input.operationId}/review.json`,prior=await reviews.read(id);
   if(prior)return{status:"review",operationId:input.operationId,reviewId:id,code:prior.failure.code,evidenceKey:key,automaticRetry:false};
   const record=ReviewRecordSchema.parse({schemaVersion:1,reviewId:id,occurredAt:new Date().toISOString(),observation:owner,failure:{schemaVersion:1,requestId:owner.requestId,observationId:owner.observationId,operationId:input.operationId,inputFingerprint:fp,stage:"channel.label-input",category:"PROCESSING",code:raw.code,executionFact:"unknown",evidenceKey:key,blockedBy:null,automaticRetry:false},rawError:{name:"ChannelLabelFailure",message:raw.code,stack:null,details:{input,states:raw.states,...(raw.failures?{failures:raw.failures}:{})}},candidate:null,inspection:{kind:"none"}});
   await publication.publish(key,Buffer.from(JSON.stringify(record)),"application/json",s);await reviews.append(record);return{status:"review",operationId:input.operationId,reviewId:id,code:record.failure.code,evidenceKey:key,automaticRetry:false};};break;}
 }
 return{activities,stops,constructed,check:async()=>{for(const check of checks)await check();},close:async()=>{await Promise.all(closers.map(close=>close()));}};
 }catch(error){await Promise.allSettled(closers.map(close=>close()));throw error;}
}
