import { gncStreamFixture } from "./gnc-stream.fixture.js";
import { ChannelLabelPlans } from "../../v3-channels/src/channel-label.js";
import { RetainedPublication } from "@crawl-automation/v3-artifacts";
import { ChannelLabelInputSchema } from "@crawl-automation/v3-contracts";
const signal=()=>AbortSignal.timeout(15000);
export async function channelSavedFixture(prepareFiles=true,channel:"swanson"|"dtc"="swanson"){
  // Synthetic source fixture only. No actual GNC source is relabelled or written to a live store.
  const f=await gncStreamFixture(false,channel==="dtc"?undefined:"variant-1");
  await f.activities.captureGncProduct!(f.input.sourcePlan.task);
  await f.activities.prepareGncProduct!({input:f.input.sourcePlan,receipt:null});
  await f.activities.loadGncLabelPlan!(f.input); // synthetic image-1 is marketing-only
  const plan=(await f.plans.inspect(f.input.sourcePlan,signal()))!;
  if(prepareFiles)for(const s of plan.manifest.sources)if(s.kind==="file-image")await f.activities.acquireSourceFile!(s.plan.acquire);
  const owner=plan.manifest.observation;
  const input=ChannelLabelInputSchema.parse({operationId:"channel-label",text:f.input.text,visionConfigFingerprint:f.input.visionConfigFingerprint,evidencePolicy:"label-image-first/1",
    sourcePlan:{operationId:plan.manifest.operationId,owner,channel,parserVersion:`${channel}-rendered/1`,expectedUrl:channel==="dtc"?"https://brand.example/products/synthetic":"https://www.swansonvitamins.com/p/synthetic",
      binding:f.input.sourcePlan.task.capture.binding,text:f.input.sourcePlan.text,ocr:f.input.sourcePlan.ocr,visionConfigFingerprint:f.input.sourcePlan.visionConfigFingerprint,
      source:{schemaVersion:1,artifactId:"synthetic",observationId:owner.observationId,sourceId:owner.sourceId,listingId:owner.listingId,variantId:owner.variantId,
        kind:"result-json",mediaType:"application/json",objectKey:"fixture/synthetic.json",sha256:"f".repeat(64),byteSize:1,
        producer:{operationId:"synthetic-capture",module:`${channel}.browser-projection`,implementationVersion:`${channel}-rendered/1`}}}});
  const bridge=new ChannelLabelPlans({inspect:async()=>plan},new RetainedPublication(f.local,f.remote),(s,abort)=>f.saved.resolve(s,{id:s.id,status:"unresolved"},abort));
  const activities={...f.activities,acquireSourceFile:f.activities.acquireSourceFile!,interpretText:f.activities.interpretText!,ocrFile:f.activities.ocrFile!,loadChannelLabelPlan:(raw:unknown)=>bridge.load(raw,signal()),
    resolveOcrReceipt:f.activities.resolveOcrReceipt!,resolveTextReceipt:f.activities.resolveTextReceipt!,
    prepareChannelLabelSource:(raw:unknown)=>bridge.source(raw,signal()),prepareChannelLabelManifest:(raw:unknown)=>bridge.manifest(raw,signal()),
    reviewChannelProduct:async(raw:any)=>({status:"review",operationId:raw.input.operationId,reviewId:"review-channel",evidenceKey:"fixture/review.json",code:raw.code,automaticRetry:false})};
  const route={...f.route,plan:"loadChannelLabelPlan",source:"prepareChannelLabelSource",manifest:"prepareChannelLabelManifest",review:"reviewChannelProduct"};
  const {capture,captureReceipts,productPlan,acquire,...savedRoute}=route;
  const activityQueues:Record<string,Record<string,(raw:any)=>Promise<any>>>={};
  for(const [queue,name]of Object.entries(savedRoute))activityQueues[queue]={[name]:raw=>(activities as any)[name](raw)};
  const queues=Object.fromEntries(Object.keys(savedRoute).map(k=>[k,k]));
  return{...f,input,activities,activityQueues,bridge,manifest:plan.manifest,entry:{input,queues}};
}
