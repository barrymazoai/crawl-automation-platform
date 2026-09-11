import { isDeepStrictEqual as equal } from "node:util";
import { CatalogDiscoverySchema, SwansonProductJobSchema, type SwansonProductJob, type CatalogDiscovery } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
import type { CatalogDatabase } from "./catalog-ledger.js";
import { SwansonFamilies } from "../../v3-channels/src/swanson-family.js";
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
type Policy = Pick<SwansonProductJob, "queues" | "resources"> & { scope: CatalogDiscovery["scope"] };

/** Resolve discovery from the ledger; never accept browser/URL work supplied only by a queue payload. */
export class SwansonProductJobs {
  constructor(readonly db: Pick<CatalogDatabase, "query">, readonly publication: RetainedPublication, readonly policy: Policy) {}
  async prepare(raw: unknown, workflowId: string, signal: AbortSignal) {
    const d = CatalogDiscoverySchema.parse(raw);
    if (d.workflowId !== workflowId || !equal(d.scope, this.policy.scope)) throw Error("SWANSON.DISCOVERY_IDENTITY");
    const row = (await this.db.query("SELECT record FROM catalog_discovery WHERE discovery_id=$1", [d.discoveryId])).rows[0];
    if (!row || !equal(CatalogDiscoverySchema.parse(row.record), d)) throw Error("SWANSON.DISCOVERY_UNVERIFIED");
    const digest = sha256(bytes(d)), job = SwansonProductJobSchema.parse({ codec: "swanson-product-job/1", discovery: d,
      operationId: `swanson-capture-${digest}`, sessionId: `swanson-page-${digest}`, queues: this.policy.queues, resources: this.policy.resources });
    const key = `v3/swanson-jobs/${d.discoveryId}.json`, encoded = bytes(job);
    const old = await this.publication.remote.read(key, 65536, signal);
    if (old) {
      if (!equal(SwansonProductJobSchema.parse(JSON.parse(Buffer.from(old).toString())), job)) throw Error("SWANSON.PRODUCT_POLICY_CONFLICT");
      return job;
    }
    await this.publication.publish(key, encoded, "application/json", signal);
    return job;
  }
  async verify(raw: unknown, workflowId: string, signal: AbortSignal) {
    const job = SwansonProductJobSchema.parse(raw);
    if(job.familyDiscovery){
      if(job.discovery.workflowId!==workflowId)throw Error("SWANSON.DISCOVERY_IDENTITY");
      const prepared=await this.prepareVariant({family:job.familyDiscovery,discovery:job.discovery},signal);
      if(!equal(prepared.job,job))throw Error("SWANSON.PRODUCT_POLICY_CONFLICT");return job;
    }
    if (!equal(await this.prepare(job.discovery, workflowId, signal), job)) throw Error("SWANSON.PRODUCT_POLICY_CONFLICT");
    return job;
  }
  async prepareVariant(raw:{family:unknown;discovery:unknown},signal:AbortSignal){
    const family=CatalogDiscoverySchema.parse(raw.family),d=CatalogDiscoverySchema.parse(raw.discovery);
    const parent=await this.prepare(family,family.workflowId,signal),families=new SwansonFamilies(this.publication),inventory=await families.inspect(parent,signal);
    if(!inventory?.discoveries.some(x=>equal(x,d)))throw Error("SWANSON.VARIANT_DISCOVERY_UNVERIFIED");
    const digest=sha256(bytes([d.catalogId,d.entry.listingId,d.entry.variantId])),candidate=SwansonProductJobSchema.parse({codec:"swanson-product-job/1",discovery:d,familyDiscovery:family,
      operationId:`swanson-capture-${digest}`,sessionId:`swanson-page-${digest}`,queues:this.policy.queues,resources:this.policy.resources});
    const key=`v3/swanson-variant-jobs/${d.discoveryId}.json`;
    await this.publication.remote.create(key,bytes(candidate),"application/json",signal);
    const saved=await this.publication.remote.read(key,65536,signal);if(!saved)throw Error("SWANSON.VARIANT_JOB_UNRESOLVED");
    const job=SwansonProductJobSchema.parse(JSON.parse(Buffer.from(saved).toString()));
    if(!job.familyDiscovery||!equal(job.discovery.entry,d.entry)||job.discovery.catalogId!==d.catalogId||job.discovery.workflowId!==d.workflowId||
      !equal(job.discovery.scope,d.scope)||job.operationId!==candidate.operationId||job.sessionId!==candidate.sessionId||!equal(job.queues,candidate.queues)||!equal(job.resources,candidate.resources))throw Error("SWANSON.VARIANT_JOB_CONFLICT");
    const origin=await this.prepare(job.familyDiscovery,job.familyDiscovery.workflowId,signal),original=await families.inspect(origin,signal);
    if(!original?.discoveries.some(x=>equal(x,job.discovery)))throw Error("SWANSON.VARIANT_DISCOVERY_UNVERIFIED");
    return {job,owned:job.familyDiscovery.discoveryId===family.discoveryId};
  }
}
