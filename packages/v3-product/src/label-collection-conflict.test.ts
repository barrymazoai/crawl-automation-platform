import {expect,it,vi} from "vitest";
import {labelProductFixture} from "./label-product.fixture.js";
import {CollectLabelProduct,PostgresLabelCollectedProducts,labelCollectedHash} from "./label-product.js";
const signal=()=>new AbortController().signal;
async function fixture(){
 const f=await labelProductFixture();f.join.manifest.evidencePolicy="label-image-first/4";
 const first=await f.assembly.run(f.join,signal());expect((await f.collector.run({join:f.join,evidenceKey:first.evidenceKey},signal())).status).toBe("collected");
 const old=[...f.collected.values()][0]!;f.join.manifest.operationId="new-quality-version";const next=await f.assembly.run(f.join,signal());
 return{...f,old,input:{join:f.join,evidenceKey:next.evidenceKey}};
}
it("retains new candidate and links old observation without another INSERT or claim",async()=>{
 const f=await fixture(),append=vi.fn(),registry={...f.registry,append,readObservation:vi.fn(async()=>f.old)};
 const c=new CollectLabelProduct({...f.deps,assembly:f.assembly,registry}),out=await c.run(f.input,signal());
 expect(out.status).toBe("review");if(out.status!=="review")throw Error();expect(out.codes).toEqual(["LABEL_COLLECTION.OBSERVATION_ALREADY_COLLECTED"]);
 const r=f.records.get(out.reviewId)!;expect(r.rawError.details).toMatchObject({versionPolicy:"retain-first/1",existingCollection:{operationId:f.old.operationId,recordHash:labelCollectedHash(f.old)}});
 expect(r.candidate).not.toBeNull();expect(append).not.toHaveBeenCalled();expect(f.remote.data.has("v3/label-products/new-quality-version/collection-intent.json")).toBe(false);
 expect(await c.run(f.input,signal())).toEqual(out);expect(f.collected.size).toBe(1);
});
it("post-INSERT race is classified by exact observation readback",async()=>{
 const f=await fixture(),readObservation=vi.fn().mockResolvedValueOnce(null).mockResolvedValue(f.old),append=vi.fn(async()=>{});
 const out=await new CollectLabelProduct({...f.deps,assembly:f.assembly,registry:{...f.registry,append,readObservation}}).run(f.input,signal());
 expect(out).toMatchObject({status:"review",codes:["LABEL_COLLECTION.OBSERVATION_ALREADY_COLLECTED"]});expect(append).toHaveBeenCalledTimes(1);
});
it("actual unconfirmed registration stays unknown rather than pretending a known conflict",async()=>{
 const f=await fixture(),out=await new CollectLabelProduct({...f.deps,assembly:f.assembly,registry:{...f.registry,append:vi.fn(async()=>{}),readObservation:async()=>null}}).run(f.input,signal());
 expect(out).toMatchObject({status:"review",codes:["LABEL_COLLECTION.REGISTRATION_UNKNOWN"]});
});
it("Postgres observation lookup verifies stored record hash and observation identity",async()=>{
 const f=await fixture(),query=vi.fn(async(sql:string)=>({rows:sql.startsWith("SELECT operation_id")?[{operation_id:f.old.operationId}]:[{observation_id:f.old.observation.observationId,record_hash:labelCollectedHash(f.old),record:f.old}]}));
 const r=new PostgresLabelCollectedProducts({query});expect(await r.readObservation(f.old.observation.observationId)).toEqual(f.old);
 await expect(r.readObservation("wrong-observation")).rejects.toThrow("LABEL_COLLECTION.INTEGRITY");
});
