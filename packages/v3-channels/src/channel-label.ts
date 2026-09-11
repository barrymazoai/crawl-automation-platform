import { isDeepStrictEqual as equal } from "node:util";
import { ChannelLabelInputSchema, ChannelLabelSourceRequestSchema, ChannelLabelSourceResultSchema, ChannelLabelManifestResultSchema,
  TextInputSchema, LabelCoreOutcomeSchema, textFingerprint, observationIdentity, type SavedEvidenceSource, type ProductResolvedEvidenceSource, type ChannelProductPlan } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
type Resolution = { status: "resolved"; source: ProductResolvedEvidenceSource } | { status: "not_matched" } | { status: "review"; code: string };
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
/** Source-local bridge to the label protocol. Page v2 tasks are never sent to a v3 model. */
export class ChannelLabelPlans {
  constructor(private readonly plans: { inspect(raw: unknown, signal: AbortSignal): Promise<Pick<ChannelProductPlan,"manifest"> | null> }, private readonly publication: RetainedPublication,
    private readonly resolve: (source: SavedEvidenceSource, signal: AbortSignal) => Promise<Resolution>,
    private readonly core?:{inspect(raw:unknown,signal:AbortSignal):Promise<unknown>}) {}
  async load(raw: unknown, signal: AbortSignal) {
    const input=ChannelLabelInputSchema.parse(raw), plan=await this.plans.inspect(input.sourcePlan,signal);
    if(!plan)throw Error("CHANNEL.LABEL_SOURCE_UNVERIFIED");
    if(plan.manifest.operationId!==input.sourcePlan.operationId||!equal(plan.manifest.observation,input.sourcePlan.owner))throw Error("CHANNEL.LABEL_IDENTITY_CONFLICT");
    return {input,manifest:plan.manifest};
  }
  async source(raw: unknown, signal: AbortSignal) {
    const request=ChannelLabelSourceRequestSchema.parse(raw),{input}=request;
    const plan=await this.load(input,signal), source=plan.manifest.sources.find(s=>s.id===request.sourceId);
    if(!source||(source.kind!=="page"&&source.kind!=="file-image"))throw Error("CHANNEL.LABEL_IDENTITY_CONFLICT");
    const resolved=await this.resolve(source,signal);
    if(resolved.status==="review")throw Error("CHANNEL.LABEL_PREPARATION_UNVERIFIED");
    let result;
    if(resolved.status==="not_matched"){
      if(source.kind!=="file-image")throw Error("CHANNEL.LABEL_IDENTITY_CONFLICT");
      result=ChannelLabelSourceResultSchema.parse({status:"not_matched",input:request});
    }else{
      const r=resolved.source,operationId=`chl-${sha256(bytes([input.operationId,source.id]))}`;
      if(r.id!==source.id)throw Error("CHANNEL.LABEL_IDENTITY_CONFLICT");
      if(!equal(r.kind==="text"?observationIdentity(r.task):r.task.input.selection.observation,input.sourcePlan.owner))throw Error("CHANNEL.LABEL_IDENTITY_CONFLICT");
      if(r.kind==="text"){
        if(source.kind!=="page"||r.task.operationId!==source.plan.textOperationId||r.task.source.kind!=="prepared"||r.task.range.start!==0||r.task.source.document.producer.operationId!==source.plan.page.operationId)throw Error("CHANNEL.LABEL_IDENTITY_CONFLICT");
        const {inputFingerprint:_old,...base}=r.task;
        if(input.corePolicy){
          if(!this.core)throw Error("CHANNEL.CORE_UNAVAILABLE");
          const coreInput={owner:input.sourcePlan.owner,fullDocument:r.task.source.document};
          const prepared=LabelCoreOutcomeSchema.parse(await this.core.inspect(coreInput,signal));
          if(!equal(prepared.input,coreInput)||prepared.document.producer.implementationVersion!==input.corePolicy)throw Error("CHANNEL.CORE_IDENTITY_CONFLICT");
          base.source={kind:"prepared",document:prepared.document};base.range=prepared.range;
        }
        const next={...base,...input.text,operationId};
        result=ChannelLabelSourceResultSchema.parse({status:"prepared",input:request,source:{id:source.id,kind:"text",required:true,
          task:TextInputSchema.parse({...next,inputFingerprint:textFingerprint(next,s=>sha256(Buffer.from(s)))})}});
      }else{
        if(source.kind!=="file-image"||r.task.input.operationId!==source.visionOperationId||r.task.input.selection.ocrOperationId!==source.plan.ocrOperationId||r.task.input.selection.image.artifactId!==source.plan.imageId||r.task.input.selection.status!=="matched")throw Error("CHANNEL.LABEL_IDENTITY_CONFLICT");
        result=ChannelLabelSourceResultSchema.parse({status:"prepared",input:request,source:{id:source.id,kind:"image",required:true,
          task:{configFingerprint:input.visionConfigFingerprint,input:{operationId,extractionProtocol:"label-extraction/1",selection:r.task.input.selection}}}});
      }
    }
    await this.publication.publish(`v3/channel-labels/${input.operationId}/sources/${source.id}.json`,bytes(result),"application/json",signal);
    return result;
  }
  async manifest(raw: unknown, signal: AbortSignal) {
    const {input,manifest}=await this.load(raw,signal),sources=[],skipped=[];
    for(const source of manifest.sources){
      const result=await this.source({input,sourceId:source.id},signal);
      if(result.status==="prepared")sources.push(result.source);else skipped.push(source.id);
    }
    const result=ChannelLabelManifestResultSchema.parse({input,manifest:{operationId:input.operationId,observation:input.sourcePlan.owner,
      evidencePolicy:input.evidencePolicy,sources},skipped});
    const key=`v3/channel-labels/${input.operationId}/manifest.json`;
    await this.publication.publish(key,bytes(result),"application/json",signal);
    const saved=await this.publication.remote.read(key,2*1024*1024,signal);
    if(!saved||!equal(JSON.parse(new TextDecoder().decode(saved)),result))throw Error("CHANNEL.LABEL_HANDOFF_UNVERIFIED");
    return result;
  }
}
