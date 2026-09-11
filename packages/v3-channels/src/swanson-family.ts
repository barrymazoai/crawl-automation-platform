import { isDeepStrictEqual as equal } from "node:util";
import { ArtifactRefSchema, CatalogDiscoverySchema, SwansonProductJobSchema, SwansonRenderedProductSchema, type SwansonProductJob } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
import { parseSwansonRenderedProduct, swansonVariantChoices } from "./swanson-rendered.js";
const bytes=(v:unknown)=>Buffer.from(JSON.stringify(v));
export interface SwansonFamilyPort {
  /** Retain the public selection evidence, then close this enumeration-only page. */
  capture(job:SwansonProductJob,signal:AbortSignal,retain:(raw:unknown)=>Promise<void>):Promise<unknown>;
}
export class SwansonFamilies {
  constructor(readonly publication:RetainedPublication,readonly browser?:SwansonFamilyPort){}
  key(job:SwansonProductJob){return `v3/swanson-families/${job.discovery.discoveryId}`;}
  derive(job:SwansonProductJob,raw:unknown){
    if(job.familyDiscovery)throw Error("SWANSON.FAMILY_IDENTITY");
    const p=SwansonRenderedProductSchema.parse(raw),form=p.selectedForms[0];
    if(!form)throw Error("SWANSON.IDENTITY_UNVERIFIED");
    parseSwansonRenderedProduct(p,job.discovery.entry.url,{listingId:form.productId,variantId:form.variantIds[0]!});
    const inventory=swansonVariantChoices(p),d=job.discovery,id=sha256(bytes(job)),encoded=bytes(p);
    const source=ArtifactRefSchema.parse({schemaVersion:1,artifactId:`family-${id}`,observationId:`family-${id}`,sourceId:d.scope.sourceId,listingId:d.entry.listingId,variantId:null,
      kind:"result-json",mediaType:"application/json",objectKey:`${this.key(job)}/projection.json`,byteSize:encoded.length,sha256:sha256(encoded),producer:{operationId:job.operationId,module:"swanson.family",implementationVersion:"swanson-family/1"}});
    const discoveries=inventory.choices.map(c=>{
      // Global per-catalog SKU identity. Overlapping families share this one delivery.
      const key=sha256(bytes([d.catalogId,c.handle,c.variantId]));
      return CatalogDiscoverySchema.parse({discoveryId:`swanson-variant-${key}`,catalogId:d.catalogId,scope:d.scope,entry:{listingId:c.handle,variantId:c.variantId,url:c.url,kind:"product"},source,workflowId:`swanson-variant-${key}`});
    });
    return {codec:"swanson-family/1" as const,job,source,coverage:inventory.coverage,choices:inventory.choices,discoveries};
  }
  async inspect(raw:unknown,signal:AbortSignal){
    const job=SwansonProductJobSchema.parse(raw),key=this.key(job),ready=await this.publication.remote.read(`${key}/ready.json`,2*1024*1024,signal);
    if(!ready)return null;
    const projection=await this.publication.remote.read(`${key}/projection.json`,4*1024*1024,signal);if(!projection)throw Error("SWANSON.FAMILY_EVIDENCE_MISSING");
    const result=this.derive(job,JSON.parse(Buffer.from(projection).toString()));
    if(!equal(JSON.parse(Buffer.from(ready).toString()),result))throw Error("SWANSON.FAMILY_EVIDENCE_CONFLICT");return result;
  }
  async capture(raw:unknown,signal:AbortSignal){
    const job=SwansonProductJobSchema.parse(raw),old=await this.inspect(job,signal);if(old)return old;if(!this.browser)throw Error("SWANSON.CAPTURE_UNAVAILABLE");
    const key=this.key(job);if(await this.publication.remote.create(`${key}/intent.json`,bytes(job),"application/json",signal)!=="created")throw Error("SWANSON.CAPTURE_UNRESOLVED");
    const retain=async(raw:unknown)=>{const p=SwansonRenderedProductSchema.parse(raw),r=this.derive(job,p);await this.publication.publish(r.source.objectKey,bytes(p),"application/json",signal);};
    const projection=await this.browser.capture(job,signal,retain),result=this.derive(job,projection);
    await retain(projection);await this.publication.publish(`${key}/ready.json`,bytes(result),"application/json",signal);return (await this.inspect(job,signal))!;
  }
}
