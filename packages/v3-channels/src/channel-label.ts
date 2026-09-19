import { isDeepStrictEqual as equal } from "node:util";
import { ChannelLabelInputSchema, ChannelLabelSourceRequestSchema, ChannelLabelSourceResultSchema, ChannelLabelManifestResultSchema, ChannelSingleLabelSelectionSchema, LabelImageCandidateSchema, isCompleteLabelImage, labelImageIntegrityCodes, ReviewRecordSchema,
  type LabelImageCandidate, type LabelProductManifest,
  TextInputSchema, LabelCoreOutcomeSchema, textFingerprint, observationIdentity, type SavedEvidenceSource, type ProductResolvedEvidenceSource, type ChannelProductPlan } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
type Resolution = { status: "resolved"; source: ProductResolvedEvidenceSource } | { status: "not_matched" } | { status: "review"; code: string };
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
/** Source-local bridge to the label protocol. Page v2 tasks are never sent to a v3 model. */
export class ChannelLabelPlans {
  constructor(private readonly plans: { inspect(raw: unknown, signal: AbortSignal): Promise<Pick<ChannelProductPlan,"manifest"> | null> }, private readonly publication: RetainedPublication,
    private readonly resolve: (source: SavedEvidenceSource, signal: AbortSignal) => Promise<Resolution>,
    private readonly core?:{inspect(raw:unknown,signal:AbortSignal):Promise<unknown>},
    private readonly inspection?:{file(source:SavedEvidenceSource,signal:AbortSignal):Promise<boolean>;image(source:LabelProductManifest["sources"][number],signal:AbortSignal):Promise<LabelImageCandidate>;review(id:string):Promise<unknown>}) {}
  async load(raw: unknown, signal: AbortSignal) {
    const input=ChannelLabelInputSchema.parse(raw), plan=await this.plans.inspect(input.sourcePlan,signal);
    if(!plan)throw Error("CHANNEL.LABEL_SOURCE_UNVERIFIED");
    if(plan.manifest.operationId!==input.sourcePlan.operationId||!equal(plan.manifest.observation,input.sourcePlan.owner))throw Error("CHANNEL.LABEL_IDENTITY_CONFLICT");
    const imageOrder=plan.manifest.sources.filter(s=>s.kind==="file-image").map(s=>s.id);
    if(input.evidencePolicy==="label-image-first/5"){
      // Filename hints choose an attempt order only; verified extraction decides completeness.
      const files=(plan as Partial<ChannelProductPlan>).files??[];
      const rank=(id:string)=>{const s=plan.manifest.sources.find(s=>s.id===id);const url=s?.kind==="file-image"?files.find(f=>f.resourceId===s.plan.acquire.resourceId)?.url??"":"";
        return /supplement.?facts|nutrition.?facts|flat.?label|label.?flat/i.test(url)?0:/label|facts/i.test(url)?1:/front/i.test(url)?3:2;};
      imageOrder.sort((a,b)=>rank(a)-rank(b));
      return {input,manifest:plan.manifest,imageOrder};
    }
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
  async imageCheck(raw:unknown,signal:AbortSignal){
    const request=ChannelLabelSourceRequestSchema.parse(raw);
    if(request.input.evidencePolicy!=="label-image-first/5"||!this.inspection)throw Error("CHANNEL.LABEL_SELECTION_UNAVAILABLE");
    const r=await this.source(request,signal);
    if(r.status!=="prepared"||r.source.kind!=="image")throw Error("CHANNEL.LABEL_IDENTITY_CONFLICT");
    const candidate=await this.inspection.image(r.source,signal);
    return {input:request,complete:isCompleteLabelImage({kind:"image",candidate})&&!labelImageIntegrityCodes(candidate).length};
  }
  async singleManifest(raw:unknown,signal:AbortSignal){
    const request=ChannelSingleLabelSelectionSchema.parse(raw),{input,states,selectedImageId}=request,loaded=await this.load(input,signal);
    if(!this.inspection)throw Error("CHANNEL.LABEL_SELECTION_UNAVAILABLE");
    const byId=new Map(states.map(s=>[s.id,s]));
    if(byId.size!==states.length||states.length!==loaded.manifest.sources.length||loaded.manifest.sources.some(s=>!byId.has(s.id)))throw Error("CHANNEL.LABEL_IDENTITY_CONFLICT");
    const order=loaded.imageOrder!,selectedIndex=selectedImageId===null?-1:order.indexOf(selectedImageId);
    if(selectedImageId!==null&&(selectedIndex<0||byId.get(selectedImageId)?.status!=="registered"||!(await this.imageCheck({input,sourceId:selectedImageId},signal)).complete))throw Error("CHANNEL.LABEL_SELECTION_UNVERIFIED");
    const sources:LabelProductManifest["sources"]=[],skipped:string[]=[],decisions:unknown[]=[];
    // Every original remains required, including images whose OCR/model was skipped.
    // Bound independent retained-file checks, and settle them before any publication.
    const files=loaded.manifest.sources.filter(s=>s.kind==="file-image");
    for(let offset=0;offset<files.length;offset+=4){
      const checks=await Promise.allSettled(files.slice(offset,offset+4).map(source=>this.inspection!.file(source,signal)));
      for(const check of checks){if(check.status==="rejected")throw check.reason;if(!check.value)throw Error("CHANNEL.LABEL_FILE_UNVERIFIED");}
    }
    for(const source of loaded.manifest.sources){
      const state=byId.get(source.id)!;
      if(state.status==="unresolved"||state.status==="rejected")throw Error("CHANNEL.LABEL_PREPARATION_UNVERIFIED");
      if(state.status==="not_started"){
        if(selectedIndex<0||(source.kind!=="page"&&(source.kind!=="file-image"||order.indexOf(source.id)<=selectedIndex)))throw Error("CHANNEL.LABEL_SELECTION_UNVERIFIED");
        skipped.push(source.id);decisions.push({id:source.id,reason:"complete_label_already_selected"});continue;
      }
      if(source.kind==="file-image"&&selectedIndex>=0&&order.indexOf(source.id)>selectedIndex)throw Error("CHANNEL.LABEL_SELECTION_UNVERIFIED");
      const resolved=await this.source({input,sourceId:source.id},signal);
      if(resolved.status==="not_matched"){
        if(state.status!=="not_matched")throw Error("CHANNEL.LABEL_IDENTITY_CONFLICT");
        skipped.push(source.id);decisions.push({id:source.id,reason:"keyword_not_matched"});continue;
      }
      if(state.status==="not_matched")throw Error("CHANNEL.LABEL_IDENTITY_CONFLICT");
      if(source.kind==="file-image"&&selectedImageId!==null&&source.id!==selectedImageId){
        if(state.status==="registered"){
          if((await this.imageCheck({input,sourceId:source.id},signal)).complete)throw Error("CHANNEL.LABEL_SELECTION_UNVERIFIED");
        }else if(state.status==="review"){
          // The state itself is the first-hand fact: an image that yielded a usable label is `registered`, so `review`
          // already proves this one did not. The record only corroborates it, and a cloud worker that loses its Codex
          // turn has no ledger to write one (2026-09-18: 139 products discarded a complete label taken from another
          // image because this lookup returned nothing). A record that IS there is still checked in full.
          const retained=await this.inspection.review(state.reviewId);
          if(!retained){skipped.push(source.id);decisions.push({id:source.id,reason:"incomplete_label_review_unretained",state});continue;}
          const r=ReviewRecordSchema.parse(retained),task=resolved.source;
          // Identity first: the Review must belong to exactly this image of this observation.
          if(task.kind!=="image"||r.reviewId!==state.reviewId||r.failure.operationId!==task.task.input.operationId||r.failure.inputFingerprint!==sha256(bytes(["vision-input/1",task.task.input,task.task.configFingerprint]))||r.failure.stage!=="codex.vision"||!equal(r.observation,input.sourcePlan.owner)||!equal(r.rawError.details,{task:task.task,evidenceKey:r.failure.evidenceKey}))throw Error("CHANNEL.LABEL_SELECTION_UNVERIFIED");
          // A turn that never produced a verdict (the model call itself failed) read no label at all, so it cannot be
          // hiding a complete one. Only a verdict is held to the completeness check below; the rest is skipped for
          // exactly the reason the Review records. 2026-09-19: 22 products were discarded here because a failed turn
          // was treated as a forged skip.
          const verdict=r.failure.executionFact==="executed"&&/^VISION\.LABEL_[A-Z_]+$/.test(r.failure.code);
          if(!verdict){skipped.push(source.id);decisions.push({id:source.id,reason:"incomplete_label_no_verdict",code:r.failure.code,state});continue;}
          const candidate=LabelImageCandidateSchema.parse(r.candidate?.value);
          if(isCompleteLabelImage({kind:"image",candidate})&&!labelImageIntegrityCodes(candidate).length)throw Error("CHANNEL.LABEL_SELECTION_UNVERIFIED");
        }else throw Error("CHANNEL.LABEL_SELECTION_UNVERIFIED");
        skipped.push(source.id);decisions.push({id:source.id,reason:"incomplete_label",state});continue;
      }
      sources.push(resolved.source);
    }
    const result=ChannelLabelManifestResultSchema.parse({input,manifest:{operationId:input.operationId,observation:input.sourcePlan.owner,evidencePolicy:input.evidencePolicy,sources},skipped});
    await this.publication.publish(`v3/channel-labels/${input.operationId}/selection.json`,bytes({request,decisions}),"application/json",signal);
    await this.publication.publish(`v3/channel-labels/${input.operationId}/manifest.json`,bytes(result),"application/json",signal);
    return result;
  }
  async manifest(raw: unknown, signal: AbortSignal) {
    const {input,manifest}=await this.load(raw,signal),sources=[],skipped=[];
    if(input.evidencePolicy==="label-image-first/5")throw Error("CHANNEL.LABEL_SELECTION_REQUIRED");
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
