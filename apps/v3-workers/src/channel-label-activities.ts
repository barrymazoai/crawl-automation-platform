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

/** Shared composition of atomic classes; each deployed process exposes only its configured activity. */
export async function channelLabelActivities(options:{root:string;remote:ObjectStore;db:pg.Pool;storageId:string;readOnlyProviders?:boolean;visionProtocol?:"label-extraction/1"|"label-extraction/2";resourceDb?:pg.Pool;
  durableStops?:boolean;codex?:Record<string,unknown>;ocrProvider?:ConstructorParameters<typeof MultipartOcr>[0];providerRole?:string}){
  const {root,remote,db,storageId}=options,local=await TextLocalStore.open(join(root,"journal"));
  const copies=await FileCopies.open(join(root,"cache")),artifacts=new ArtifactResolver(copies,remote),reviews=new PostgresReviews(db);
  const publication=new RetainedPublication(local,remote),files=new FileEvidence({local,remote,copies,reviews});
  const stops=new QualityReviewStops(publication,reviews,options.durableStops);
  const pages=new PageEvidence({local,remote,reviews}),page=new PreparePageModule(pages),pageText=new PreparePageText(pages),image=new PrepareImageOcr(files);
  const registry=new PostgresResultRegistry(db),results=new OcrResultHandoff(storageId,copies,remote,await FileCompletionJournal.open(join(root,"ocr-journal")),registry);
  const counts={ocr:0,text:0,vision:0},ocrProvider=new MultipartOcr(options.ocrProvider??{endpoint:"http://192.168.0.6:8081/ocr",trustedHttpOrigin:"http://192.168.0.6:8081",provider:"paddle-ocr/1",minScore:0.3});
  const ocr=new OcrFileModule({provider:{provider:ocrProvider.provider,supported:ocrProvider.supported,close:()=>ocrProvider.close(),
    recognize:async(...args)=>{if(options.readOnlyProviders)throw Error("COLD_PROVIDER_FORBIDDEN");counts.ocr++;return ocrProvider.recognize(...args,response=>stops.returned(response));}},artifacts,intents:new OcrIntents(remote,"mini-channel-label",storageId),results,reviews});
  const receipt=new ResolveOcrReceipt({results,local,reviews}),screen=new RegisteredOcrEvidence(artifacts,results,registry),keywords=new KeywordPublication(local,remote);
  const config=options.codex??{settings:{provider:"openai",model:"gpt-5.6-luna",reasoningEffort:"medium"},executable:"/opt/homebrew/bin/codex",codexHome:"/Users/barry/.codex",
    workRoot:join(root,"model-work"),runtimeProfileVersion:"gnc-persistent-auth/1",timeoutMs:240000,disabledMcpServers:["node_repl","computer-use"],extractionProtocol:"label-extraction/1"};
  // SSH/launchd may omit Homebrew from PATH; npm's Codex launcher uses /usr/bin/env node.
  // Scope this to owned child processes, without editing the host shell or global environment.
  const environment={...process.env,PATH:[dirname(process.execPath),process.env.PATH].filter(Boolean).join(delimiter)};
  const visionConfig={...config,extractionProtocol:options.visionProtocol??"label-extraction/1"};
  const textMeta=CodexTextProvider.describe(config),visionMeta=CodexVisionProvider.describe(visionConfig);
  const textProvider=!options.providerRole||options.providerRole==="text"?await CodexTextProvider.open(config,environment):undefined;
  const visionProvider=!options.providerRole||options.providerRole==="vision"?await CodexVisionProvider.open(visionConfig,environment):undefined;
  const textEvidence=new TextEvidence(artifacts,results),textHandoff=new TextHandoff(local,remote,new PostgresTextRegistry(db),textEvidence,storageId);
  const text=new TextModule({provider:{provider:"codex-app-server/2",supported:textMeta,policy:{executionRetries:0,internalModelRequests:"codex-managed",toolAccess:"runtime-profile",modelFallback:false,networkSwitching:false},close:async()=>{await textProvider?.close();},
    interpret:async(...args)=>{if(options.readOnlyProviders||!textProvider)throw Error("COLD_PROVIDER_FORBIDDEN");counts.text++;const response=await textProvider.interpret(...args,()=>stops.closed());stops.returned(response);return response;}},handoff:textHandoff,reviews,nodeId:"mini-channel-label"});
  const textReceipt=new ResolveTextReceipt({results:textHandoff,local,reviews});
  const visionHandoff=new VisionHandoff(local,remote,new PostgresVisionRegistry(db),storageId,async(task,signal)=>{await screen.verifiedText(task.input.selection,signal);});
  const vision=new VisionModule({provider:{fingerprint:visionMeta.configFingerprint,extractionProtocol:visionMeta.extractionProtocol,
    interpret:async(...args)=>{if(options.readOnlyProviders||!visionProvider)throw Error("COLD_PROVIDER_FORBIDDEN");counts.vision++;const response=await visionProvider.interpret(...args,()=>stops.closed());stops.returned(response);return response;}},store:remote,localEvidence:local,
    verifiedOcrText:(s,a)=>screen.verifiedText(s,a),resolve:async(f,a,owner)=>(await artifacts.resolve(f,owner,a)).bytes});
  const recordVisionReview=visionReviewWriter(local,reviews);
  const saved=new SavedSourceEvidence({remote,files,pages,reviews,ocr:registry,screen});
  const core=new PrepareSwansonLabelCore(artifacts,remote);
  const plans=new ChannelProductPlans(publication,artifacts,reviews),labels=new ChannelLabelPlans(plans,publication,(source,signal)=>saved.resolve(source,{id:source.id,status:"unresolved"},signal),core);
  const assembly=new LabelProductAssembly({local,remote,reviews,readSource:async(source,signal)=>{
    if(source.kind==="image")return{id:source.id,kind:"image",...await visionHandoff.readLabelCandidate(source.task,signal)};
    const facts=await textHandoff.inspect(source.task,signal);
    if(!facts.artifactDurable||!facts.resultRegistered||!facts.record)throw Error("LABEL_PRODUCT.TEXT_UNVERIFIED");
    const bytes=await remote.read(facts.record.result.objectKey,524288,signal);if(!bytes)throw Error("LABEL_PRODUCT.TEXT_UNVERIFIED");
    verifyBytes(facts.record.result,bytes,524288);
    return{id:source.id,kind:"text",record:facts.record,candidate:TextCandidateV3Schema.parse(TextOutputSchema.parse(JSON.parse(Buffer.from(bytes).toString())).candidate),
      fullText:(await textEvidence.resolve(source.task,signal)).text};
  }});
  const collection=new PostgresLabelCollectedProducts(db),collector=new CollectLabelProduct({local,remote,reviews,assembly,registry:collection}),admission=new PostgresResourceAdmission(options.resourceDb??db);
  const activities:Record<string,(raw:any,signal:AbortSignal)=>Promise<unknown>>={
    loadChannelLabelPlan:(raw,s)=>labels.load(raw,s),prepareHtmlPage:(raw,s)=>page.run(raw,s),preparePageText:(raw,s)=>pageText.run(raw,s),
    prepareImageOcr:(raw,s)=>image.run(raw,s),ocrFile:(raw,s)=>ocr.run(raw,s),resolveOcrReceipt:(raw,s)=>receipt.run(raw,s),
    screenImageKeywords:async(raw,s)=>{const selected=await screen.screen(raw,s);return{status:selected.status,imageId:selected.image.artifactId,selection:selected,...await keywords.publish(selected,s)};},
    prepareChannelLabelSource:(raw,s)=>labels.source(raw,s),prepareChannelLabelManifest:(raw,s)=>labels.manifest(raw,s),
    prepareSwansonLabelCore:(raw,s)=>core.run(raw,s),
    interpretText:(raw,s)=>text.run(raw,s),resolveTextReceipt:(raw,s)=>textReceipt.run(raw,s),
    interpretImage:async(raw,signal)=>{
      const task=VisionTaskSchema.parse(raw);
      if(task.configFingerprint!==visionMeta.configFingerprint)throw Error("VISION.CONFIG_MISMATCH");
      const old=await visionHandoff.inspect(task,signal);if(old)return{status:"registered",operationId:task.input.operationId};
      let outcome=await vision.run(task.input,signal);
      if(outcome.status!=="review"){
        if(outcome.replayed)outcome={...outcome,status:"review",code:"VISION.HANDOFF_PENDING"};
        else try{await visionHandoff.complete(task,signal);return{status:"registered",operationId:task.input.operationId};}
        catch{outcome={...outcome,status:"review",code:"VISION.HANDOFF_PENDING"};}
      }
      return{status:"review",code:outcome.code,automaticRetry:false,...await recordVisionReview(task,outcome,AbortSignal.timeout(10000))};
    },
    assembleLabelProduct:(raw,s)=>assembly.run(raw,s),collectLabelProduct:(raw,s)=>collector.run(raw,s),
    reviewChannelProduct:async(raw,s)=>{
      if(!["CHANNEL.LABEL_PREPARATION_UNVERIFIED","CHANNEL.DEPENDENCY_UNAVAILABLE"].includes(raw.code))throw Error("CHANNEL.REVIEW_CODE_REJECTED");
      const input=ChannelLabelInputSchema.parse(raw.input),owner=input.sourcePlan.owner,fp=sha256(Buffer.from(JSON.stringify(input))),id=`chl-review-${fp}`,key=`v3/channel-labels/${input.operationId}/review.json`;
      const prior=await reviews.read(id);
      if(prior)return{status:"review",operationId:input.operationId,reviewId:id,code:prior.failure.code,evidenceKey:key,automaticRetry:false};
      const record=ReviewRecordSchema.parse({schemaVersion:1,reviewId:id,occurredAt:new Date().toISOString(),observation:owner,
        failure:{schemaVersion:1,requestId:owner.requestId,observationId:owner.observationId,operationId:input.operationId,inputFingerprint:fp,
          stage:"channel.label-input",category:"PROCESSING",code:raw.code,executionFact:"unknown",evidenceKey:key,blockedBy:null,automaticRetry:false},
        rawError:{name:"ChannelLabelFailure",message:raw.code,stack:null,details:{input,states:raw.states,...(raw.failures?{failures:raw.failures}:{})}},candidate:null,inspection:{kind:"none"}});
      await publication.publish(key,Buffer.from(JSON.stringify(record)),"application/json",s);await reviews.append(record);
      return{status:"review",operationId:input.operationId,reviewId:id,code:record.failure.code,evidenceKey:key,automaticRetry:false};
    },
    reserveResources:raw=>admission.reserve(raw),releaseResources:raw=>admission.release(raw),
    verifyResourceReviewStopped:(raw,s)=>stops.verify(raw,s),
  };
  const route={plan:"loadChannelLabelPlan",page:"prepareHtmlPage",pageText:"preparePageText",imagePrepare:"prepareImageOcr",ocr:"ocrFile",ocrReceipts:"resolveOcrReceipt",
    keywords:"screenImageKeywords",source:"prepareChannelLabelSource",manifest:"prepareChannelLabelManifest",text:"interpretText",textReceipts:"resolveTextReceipt",vision:"interpretImage",
    core:"prepareSwansonLabelCore",assembly:"assembleLabelProduct",collection:"collectLabelProduct",review:"reviewChannelProduct"};
  return{activities,route,counts,stops,text:textMeta,visionFingerprint:visionMeta.configFingerprint,ocr:ocrProvider.supported,collection,labels,
    check:async()=>{await assertLabelVisionRegistrySchema(db,options.visionProtocol??"label-extraction/1");await textProvider?.check(AbortSignal.timeout(30000));await visionProvider?.check(AbortSignal.timeout(30000));},
    close:async()=>{await textProvider?.close();await visionProvider?.close();await ocrProvider.close();}};
}
