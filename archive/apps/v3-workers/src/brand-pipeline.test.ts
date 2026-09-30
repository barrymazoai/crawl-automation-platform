import { expect,it,vi } from "vitest";
import { randomUUID } from "node:crypto";
import { BrandPipeline,scopeForSubmission } from "./brand-pipeline.js";
import { catalogProductPolicy } from "../../../packages/v3-product/src/catalog-product.fixture.js";
import type { GncCaptureEvidence } from "@crawl-automation/v3-channels";
const input={version:1,requestId:randomUUID(),snapshot:{brandId:randomUUID(),brandName:"FocusFuel",sourceId:randomUUID(),sourceRevision:1,channel:"gnc",region:"US",url:"https://www.gnc.com/brands/focus-fuel/"}};
function fixture(){
  const query=vi.fn(async(sql:string)=>({rows:sql.includes("collection_submission")?[{snapshot:input.snapshot}]:[],rowCount:1}));
  const config:any={policy:{...catalogProductPolicy("template"),scope:scopeForSubmission(input)},network:{routeId:"mini",version:"v1",mode:"host",managed:false,egressId:"mini-ego"},catalogQueue:"catalog",catalogQueues:{source:"source",ledger:"ledger",product:"product"},maxPages:1,resources:{queue:"resource",activities:{readCatalogPage:[{resourceId:"browser",units:1}]}}};
  return {query,pipeline:new BrandPipeline(config,{query,connect:vi.fn()},{} as GncCaptureEvidence)};
}
it("web snapshot creates scoped bounded catalog plan without executing browser",async()=>{
  const {pipeline}=fixture();const plan=await pipeline.prepare(input,`v3-collection-${input.requestId}`);expect(plan.catalog.catalogId).toBe(input.requestId);expect(plan.catalog.maxPages).toBe(1);expect(plan.catalog.scope.scopeVersion).toBe("source-revision-1");
});
it("same catalog input deterministically resolves identical capture identity",async()=>{
  const {pipeline}=fixture(),page={catalogId:input.requestId,scope:scopeForSubmission(input),page:0,cursor:null};
  const a=await pipeline.captureInput(page);expect(await pipeline.captureInput(page)).toEqual(a);expect(a.capture.url).toBe(input.snapshot.url);expect(a.capture.binding.sessionId.length).toBeLessThanOrEqual(64);
});
it.each(["workflow","snapshot","scope","cursor","page-limit","missing-submission"])("rejects %s before granting browser",async mode=>{
  const {pipeline,query}=fixture();
  if(mode==="missing-submission")query.mockResolvedValue({rows:[],rowCount:0});
  if(mode==="workflow")await expect(pipeline.prepare(input,"wrong")).rejects.toThrow("WORKFLOW_IDENTITY");
  else if(mode==="snapshot")await expect(pipeline.prepare({...input,snapshot:{...input.snapshot,brandName:"Changed"}},`v3-collection-${input.requestId}`)).rejects.toThrow("WORKFLOW_IDENTITY");
  else await expect(pipeline.captureInput({catalogId:input.requestId,scope:{...scopeForSubmission(input),...(mode==="scope"?{region:"CA"}:{})},page:mode==="page-limit"?1:0,cursor:mode==="cursor"?"https://www.gnc.com/foreign/":null})).rejects.toThrow();
});
