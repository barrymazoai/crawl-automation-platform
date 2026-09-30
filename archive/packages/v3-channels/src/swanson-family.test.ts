import { expect,it,vi } from "vitest";
import { swansonLiveFixture,SwansonMemory } from "./swanson-live.fixture.js";
import { swansonVariantChoices } from "./swanson-rendered.js";
import { SwansonFamilies } from "./swanson-family.js";
import { SwansonProductJobs } from "../../v3-product/src/swanson-product-jobs.js";
import { RetainedPublication } from "@crawl-automation/v3-artifacts";
const signal=()=>AbortSignal.timeout(3000);
function options(p:any){return {...p,variantPicker:{unmapped:0,options:[
  {group:"Size",label:"current size",url:p.canonicalUrl,variantId:p.selectedForms[0].variantIds[0],selected:true,available:true},
  {group:"Size",label:"other size",url:"https://www.swansonvitamins.com/p/connected-size",variantId:"999",selected:false,available:false},
]}};}
async function fixture(){
 const f=swansonLiveFixture(),raw=await f.job(),records=new Map([[raw.discovery.discoveryId,raw.discovery]]);
 const db={query:vi.fn(async(_sql:string,args:any[]=[])=>({rows:records.has(args[0])?[{record:records.get(args[0])}]:[],rowCount:records.has(args[0])?1:0}))};
 const jobs=new SwansonProductJobs(db,f.publication,{scope:f.scope,queues:raw.queues,resources:raw.resources}),job=await jobs.prepare(raw.discovery,raw.discovery.workflowId,signal());
 const p=options(f.product),capture=vi.fn(async(_j:any,_s:any,retain:any)=>{await retain(p);return p;}),families=new SwansonFamilies(f.publication,{capture});
 return {...f,records,jobs,job,p,capture,families};
}
it("explicit linked choices enumerate both available and unavailable sizes without sharing product IDs",()=>{
 const f=swansonLiveFixture(),r=swansonVariantChoices(options(f.product));expect(r.coverage).toBe("declared-options");expect(r.choices).toHaveLength(2);expect(r.choices[1]).toMatchObject({variantId:"999",available:false,url:"https://www.swansonvitamins.com/p/connected-size?variant=999"});expect(r.choices[1]).not.toHaveProperty("listingId");
});
it("a selected form and no picker remain selected-only",()=>{const f=swansonLiveFixture();expect(swansonVariantChoices(f.product).coverage).toBe("selected-only");});
it.each(["foreign","selected","duplicate","multi-axis","unmapped"])("rejects ambiguous or foreign option evidence: %s",mode=>{
 const p=options(swansonLiveFixture().product);
 if(mode==="foreign")p.variantPicker.options[1]!.url="https://evil.example/p/item";
 if(mode==="selected")p.variantPicker.options[1]!.selected=true;
 if(mode==="duplicate")p.variantPicker.options[1]!.variantId=p.variantPicker.options[0]!.variantId;
 if(mode==="multi-axis")p.variantPicker.options[1]!.group="Flavor";
 if(mode==="unmapped")p.variantPicker.unmapped=1;
 expect(()=>swansonVariantChoices(p)).toThrow();
});
it("family evidence survives cold read and cannot become ready before close",async()=>{
 const f=await fixture(),r=await f.families.capture(f.job,signal());expect(r.discoveries).toHaveLength(2);
 expect(await new SwansonFamilies(new RetainedPublication(new SwansonMemory(),f.remote)).inspect(f.job,signal())).toEqual(r);expect(f.capture).toHaveBeenCalledOnce();
 const g=await fixture(),bad=new SwansonFamilies(g.publication,{capture:async(_j,_s,retain)=>{await retain(g.p);throw Error("SOURCE.PAGE_CLOSE_UNKNOWN");}});
 await expect(bad.capture(g.job,signal())).rejects.toThrow("PAGE_CLOSE_UNKNOWN");expect(await bad.inspect(g.job,signal())).toBeNull();await expect(bad.capture(g.job,signal())).rejects.toThrow("CAPTURE_UNRESOLVED");
});
it("distinct SKU jobs bind declared variants and retain policy and discovery ownership",async()=>{
 const f=await fixture(),r=await f.families.capture(f.job,signal()),members=await Promise.all(r.discoveries.map(discovery=>f.jobs.prepareVariant({family:f.job.discovery,discovery},signal())));
 expect(new Set(members.map(m=>m.job.operationId)).size).toBe(2);expect(members.every(m=>m.owned)).toBe(true);
 for(const {job}of members)expect(await f.jobs.verify(job,job.discovery.workflowId,signal())).toEqual(job);
 const changed={...r.discoveries[1]!,entry:{...r.discoveries[1]!.entry,variantId:"123"}};
 await expect(f.jobs.prepareVariant({family:f.job.discovery,discovery:changed},signal())).rejects.toThrow("UNVERIFIED");
 f.productBrowser.capture.mockResolvedValue(f.product);
 await expect(f.live.capture(members[1]!.job,signal())).rejects.toThrow();
});
it("overlapping families share one immutable global SKU delivery",async()=>{
 const f=await fixture(),a=await f.families.capture(f.job,signal());
 const family={...f.job.discovery,discoveryId:"second-family",workflowId:"second-family"};f.records.set(family.discoveryId,family);
 const job=await f.jobs.prepare(family,family.workflowId,signal()),b=await f.families.capture(job,signal());
 const first=await f.jobs.prepareVariant({family:f.job.discovery,discovery:a.discoveries[0]},signal());
 const second=await f.jobs.prepareVariant({family,discovery:b.discoveries[0]},signal());
 expect(first.owned).toBe(true);expect(second.owned).toBe(false);expect(second.job).toEqual(first.job);
});
