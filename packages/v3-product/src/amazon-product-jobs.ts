import { isDeepStrictEqual as equal } from "node:util";
import { CatalogDiscoverySchema, AmazonProductJobSchema, type AmazonProductJob, type CatalogDiscovery } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
import type { CatalogDatabase } from "./catalog-ledger.js";
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
type Policy = Pick<AmazonProductJob, "queues" | "resources"> & { scope: CatalogDiscovery["scope"] };

/** Resolve discovery from the ledger; never accept browser/URL work supplied only by a queue payload. */
export class AmazonProductJobs {
  constructor(readonly db: Pick<CatalogDatabase, "query">, readonly publication: RetainedPublication, readonly policy: Policy) {}
  async prepare(raw: unknown, workflowId: string, signal: AbortSignal) {
    const d = CatalogDiscoverySchema.parse(raw);
    if (d.workflowId !== workflowId || !equal(d.scope, this.policy.scope)) throw Error("AMAZON.DISCOVERY_IDENTITY");
    const row = (await this.db.query("SELECT record FROM catalog_discovery WHERE discovery_id=$1", [d.discoveryId])).rows[0];
    if (!row || !equal(CatalogDiscoverySchema.parse(row.record), d)) throw Error("AMAZON.DISCOVERY_UNVERIFIED");
    const digest = sha256(bytes(d)), job = AmazonProductJobSchema.parse({ codec: "amazon-product-job/1", discovery: d,
      operationId: `amazon-capture-${digest}`, sessionId: `amazon-page-${digest}`, queues: this.policy.queues, resources: this.policy.resources });
    const key = `v3/amazon-jobs/${d.discoveryId}.json`, encoded = bytes(job);
    const old = await this.publication.remote.read(key, 65536, signal);
    if (old) {
      if (!equal(AmazonProductJobSchema.parse(JSON.parse(Buffer.from(old).toString())), job)) throw Error("AMAZON.PRODUCT_POLICY_CONFLICT");
      return job;
    }
    await this.publication.publish(key, encoded, "application/json", signal);
    return job;
  }
  async verify(raw: unknown, workflowId: string, signal: AbortSignal) {
    const job = AmazonProductJobSchema.parse(raw);
    if (!equal(await this.prepare(job.discovery, workflowId, signal), job)) throw Error("AMAZON.PRODUCT_POLICY_CONFLICT");
    return job;
  }
}
