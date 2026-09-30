import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import { CollectionWorkflowInput,CatalogScopeSchema,CatalogPageInputSchema,CatalogPageSchema,GncAcquireInputSchema,GncCatalogProductPolicySchema,BrandCollectionPlanSchema,ResourceGateSchema,VersionTagSchema,type CatalogPageInput,type CatalogPage } from "@crawl-automation/v3-contracts";
import { GncCaptureEvidence,SavedGncCatalogSource,AcquireGncModule,GncAdapter,GncBrowserReader } from "@crawl-automation/v3-channels";
import { EgoNavigatingBrowser, EgoTaskPages } from "@crawl-automation/v3-acquisition";
import { TextLocalStore } from "@crawl-automation/v3-text";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";
import type { CatalogDatabase } from "../../../packages/v3-product/src/catalog-ledger.js";
import { LiveGncConfig } from "./live-gnc-config.js";
export const BrandPipelineConfig=LiveGncConfig.extend({clusterId:z.string().min(1),
  policy:GncCatalogProductPolicySchema.refine(p=>p.browserPhase===true),catalogQueue:VersionTagSchema,
  catalogQueues:z.strictObject({source:VersionTagSchema,ledger:VersionTagSchema,product:VersionTagSchema}),
  resources:ResourceGateSchema,maxPages:z.number().int().min(1).max(10),
});
export type BrandPipelineConfig=z.infer<typeof BrandPipelineConfig>;
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function scopeForSubmission(raw:unknown){const input=CollectionWorkflowInput.parse(raw),s=input.snapshot;return CatalogScopeSchema.parse({brandId:s.brandId,sourceId:s.sourceId,channel:s.channel,region:s.region,rootUrl:s.url,scopeVersion:`source-revision-${s.sourceRevision}`});}
/** Current bounded deployment authorizes one explicit source revision; accepting a Brand is not arbitrary URL execution. */
export class BrandPipeline {
  constructor(readonly config:BrandPipelineConfig,readonly db:CatalogDatabase,readonly evidence:GncCaptureEvidence){}
  async submission(catalogId:string){
    if(!z.uuid().safeParse(catalogId).success)throw Error("CATALOG.SUBMISSION_REQUIRED");
    const row=(await this.db.query("SELECT snapshot FROM collection_submission WHERE request_id=$1",[catalogId])).rows[0];
    if(!row)throw Error("CATALOG.SUBMISSION_REQUIRED");
    const input=CollectionWorkflowInput.parse({version:1,requestId:catalogId,snapshot:row.snapshot});
    if(!equal(scopeForSubmission(input),this.config.policy.scope))throw Error("CATALOG.SCOPE_CONFLICT");
    return input;
  }
  async prepare(raw:unknown,workflowId:string){
    const input=CollectionWorkflowInput.parse(raw),stored=await this.submission(input.requestId);
    if(!equal(input,stored)||workflowId!==`v3-collection-${input.requestId}`)throw Error("CATALOG.WORKFLOW_IDENTITY");
    return BrandCollectionPlanSchema.parse({catalog:{catalogId:input.requestId,scope:scopeForSubmission(input),queues:this.config.catalogQueues,
      maxPages:this.config.maxPages,resources:this.config.resources},catalogQueue:this.config.catalogQueue});
  }
  async captureInput(raw:unknown){
    const input=CatalogPageInputSchema.parse(raw);await this.submission(input.catalogId);
    if(!equal(input.scope,this.config.policy.scope)||input.page>=this.config.maxPages)throw Error("CATALOG.SCOPE_CONFLICT");
    if(input.page===0){if(input.cursor!==null)throw Error("CATALOG.PAGE_GAP");}
    else {
      const previous=(await this.db.query("SELECT record FROM catalog_page WHERE catalog_id=$1 AND page_index=$2",[input.catalogId,input.page-1])).rows[0];
      if(!previous||previous.record.completion!=="more"||previous.record.nextCursor!==input.cursor)throw Error("CATALOG.PAGE_GAP");
    }
    const key=hash(["live-gnc-catalog/1",input]),owner={schemaVersion:1,requestId:input.catalogId,observationId:`catalog-observation-${key}`,brandId:input.scope.brandId,sourceId:input.scope.sourceId,listingId:"catalog",variantId:null};
    return GncAcquireInputSchema.parse({schemaVersion:1,implementationVersion:"gnc-acquire/1",owner,network:this.config.network,capture:{kind:"catalog-page",operationId:`catalog-capture-${key}`,requestId:owner.requestId,brandId:owner.brandId,sourceId:owner.sourceId,url:input.cursor??input.scope.rootUrl,binding:{sessionId:`catalog-${key.slice(0,48)}`,egressId:this.config.network.egressId}}});
  }
  async read(raw:unknown,execution:{workflowId:string;runId:string},signal:AbortSignal){
    const input=CatalogPageInputSchema.parse(raw),capture=await this.captureInput(input);
    if(execution.workflowId!==`v3-collection-${input.catalogId}-catalog`)throw Error("CATALOG.WORKFLOW_IDENTITY");
    const admission=new PostgresResourceAdmission(this.db);
    const {targetId:_target,sessionId:_session,...space}=this.config.browser;
    const pages=new EgoTaskPages(space,await TextLocalStore.open(this.config.pageJournalRoot));
    const taskId=capture.capture.binding.sessionId;
    let userControl=false;
    const module=new AcquireGncModule(this.evidence,new GncAdapter({read:async(task,signal)=>{
      await admission.requireHeld(this.config.browserResource,execution.workflowId,execution.runId);
      try {
        const page=await pages.open(taskId,signal);
        const browser=new EgoNavigatingBrowser(page,this.config.network.egressId,[capture.capture.url]);
        return await new GncBrowserReader(this.config.network,browser,[{input:capture.capture,expiresAt:new Date(Date.now()+120000).toISOString()}]).read(task,signal);
      }catch(error){if(error instanceof Error&&error.message==="SOURCE.BROWSER_USER_CONTROL")userControl=true;throw error;}
    }}));
    let result;
    try{result=await module.run(capture,signal);}
    finally{if(!userControl)await pages.close(taskId,AbortSignal.timeout(15000));}
    if(result.status!=="durable")throw Error("CATALOG.CAPTURE_REVIEW");
    return new SavedGncCatalogSource(this.evidence,[{input,capture}]).read(input,signal);
  }
  async verify(raw:CatalogPage,signal:AbortSignal){
    const page=CatalogPageSchema.parse(raw),capture=await this.captureInput(page.input);
    return new SavedGncCatalogSource(this.evidence,[{input:page.input,capture}]).verify(page,signal);
  }
}
