import { expect, it, vi } from "vitest";
import type { GncAcquireInput, ReviewRecord } from "@crawl-automation/v3-contracts";
import { catalogScope } from "../../v3-contracts/src/catalog.fixture.js";
import { GncAdapter } from "./gnc.js";
import { AcquireGncModule, GncCaptureEvidence } from "./gnc-handoff.js";
import { SavedGncCatalogSource } from "./gnc-catalog-source.js";
class Memory {
  data = new Map<string, Uint8Array>();
  read = vi.fn(async (key: string) => this.data.get(key) ?? null);
  create = vi.fn(async (key: string, bytes: Uint8Array) => { if (this.data.has(key)) return "exists" as const; this.data.set(key,Buffer.from(bytes));return "created" as const; });
}
async function fixture(){
  const input={catalogId:"test-catalog",scope:catalogScope,page:0,cursor:null};
  const task:GncAcquireInput={schemaVersion:1,implementationVersion:"gnc-acquire/1",owner:{schemaVersion:1,requestId:"req",observationId:"obs",brandId:catalogScope.brandId,sourceId:"gnc",listingId:"catalog",variantId:null},
    capture:{kind:"catalog-page",requestId:"req",operationId:"capture",brandId:catalogScope.brandId,sourceId:"gnc",binding:{sessionId:"s",egressId:"host/1"},url:catalogScope.rootUrl},network:{routeId:"r",version:"1",egressId:"host/1",mode:"host",managed:false}};
  const local=new Memory(),remote=new Memory(), records=new Map<string,ReviewRecord>();
  const evidence=new GncCaptureEvidence({local,remote,reviews:{read:async id=>records.get(id)??null,append:async r=>{records.set(r.reviewId,r);}}});
  const read=vi.fn(async()=>({operationId:task.capture.operationId,requestedUrl:task.capture.url,finalUrl:task.capture.url,binding:task.capture.binding,status:200,contentType:"text/html",network:task.network,
    bytes:Buffer.from('<div class="product-tile"><a href="/123456.html">One</a></div>')}));
  expect(await new AcquireGncModule(evidence,new GncAdapter({read})).run(task,AbortSignal.timeout(5000))).toMatchObject({status:"durable"});
  return {input,task,remote,read,evidence,source:new SavedGncCatalogSource(evidence,[{input,capture:task}])};
}
it("real GNC capture/parser -> generic source never promotes missing next link to completeness",async()=>{
  const f=await fixture(),p=await f.source.read(f.input,AbortSignal.timeout(5000));expect(p).toMatchObject({completion:"unknown",endEvidence:null,entries:[{listingId:"123456",kind:"product"}]});
  const puts=f.remote.create.mock.calls.length;await f.source.verify(p,AbortSignal.timeout(5000));expect(f.read).toHaveBeenCalledTimes(1);expect(f.remote.create).toHaveBeenCalledTimes(puts);
});
it("forged entries cannot be committed against existing source evidence",async()=>{
  const f=await fixture(),p=await f.source.read(f.input,AbortSignal.timeout(5000));p.entries[0]!.listingId="foreign";await expect(f.source.verify(p,AbortSignal.timeout(5000))).rejects.toThrow("PAGE_CONFLICT");
});
it("foreign scope or ungranted cursor never triggers browser fallback",async()=>{
  const f=await fixture();await expect(f.source.read({...f.input,cursor:"https://www.gnc.com/other"},AbortSignal.timeout(5000))).rejects.toThrow("GRANT_MISMATCH");expect(f.read).toHaveBeenCalledTimes(1);
});
it("corrupted retained evidence never produces discoveries",async()=>{
  const f=await fixture(),p=await f.source.read(f.input,AbortSignal.timeout(5000));f.remote.data.set(p.source.objectKey,Buffer.from("corrupt"));await expect(f.source.read(f.input,AbortSignal.timeout(5000))).rejects.toThrow();
});
