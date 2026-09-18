import { isDeepStrictEqual as equal } from "node:util";
import { CatalogDiscoverySchema, AmazonProductJobSchema, type AmazonProductJob, type CatalogDiscovery } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
import type { CatalogDatabase } from "./catalog-ledger.js";
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
type Policy = Pick<AmazonProductJob, "queues" | "resources"> & { scope: CatalogDiscovery["scope"]; stopAfter?: "full" | "observation" };
/** What the retained record proves is WHICH product this is: the verified discovery and the operation and session
 * ids derived from it. Where a run stops, which queues carry it and which resources admit it are the deployment's
 * policy at the time it ran, and they legitimately differ between runs — a price-only pass resuming through the full
 * pipeline, a lane added to the gate. Comparing those closed every product captured under an earlier policy
 * (2026-09-18: a stopAfter change, then a resources change, each killed thousands of products on contact). */
const identity = (job: AmazonProductJob) =>
  ({ codec: job.codec, discovery: job.discovery, operationId: job.operationId, sessionId: job.sessionId });
const sameProduct = (a: AmazonProductJob, b: AmazonProductJob) => equal(identity(a), identity(b));

/** Resolve discovery from the ledger; never accept browser/URL work supplied only by a queue payload. */
export class AmazonProductJobs {
  constructor(readonly db: Pick<CatalogDatabase, "query">, readonly publication: RetainedPublication, readonly policy: Policy) {}
  async prepare(raw: unknown, workflowId: string, signal: AbortSignal) {
    const d = CatalogDiscoverySchema.parse(raw);
    if (d.workflowId !== workflowId || !equal(d.scope, this.policy.scope)) throw Error("AMAZON.DISCOVERY_IDENTITY");
    const row = (await this.db.query("SELECT record FROM catalog_discovery WHERE discovery_id=$1", [d.discoveryId])).rows[0];
    if (!row || !equal(CatalogDiscoverySchema.parse(row.record), d)) throw Error("AMAZON.DISCOVERY_UNVERIFIED");
    const digest = sha256(bytes(d)), job = AmazonProductJobSchema.parse({ codec: "amazon-product-job/1", discovery: d,
      operationId: `amazon-capture-${digest}`, sessionId: `amazon-page-${digest}`, queues: this.policy.queues, resources: this.policy.resources,
      ...(this.policy.stopAfter ? { stopAfter: this.policy.stopAfter } : {}) });
    const key = `v3/amazon-jobs/${d.discoveryId}.json`, encoded = bytes(job);
    const old = await this.publication.remote.read(key, 65536, signal);
    if (old) {
      if (!sameProduct(AmazonProductJobSchema.parse(JSON.parse(Buffer.from(old).toString())), job)) throw Error("AMAZON.PRODUCT_POLICY_CONFLICT");
      return job;
    }
    await this.publication.publish(key, encoded, "application/json", signal);
    return job;
  }
  async verify(raw: unknown, workflowId: string, signal: AbortSignal) {
    const job = AmazonProductJobSchema.parse(raw);
    // A product already running under an earlier stopping point keeps its own: only the identity must match.
    if (!sameProduct(await this.prepare(job.discovery, workflowId, signal), job)) throw Error("AMAZON.PRODUCT_POLICY_CONFLICT");
    return job;
  }
}
