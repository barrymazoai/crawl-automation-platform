import { isDeepStrictEqual as equal } from "node:util";
import { AmazonProductJobSchema, AmazonProductCaptureSchema, AmazonRenderedProductSchema, ChannelPlanInputSchema,
  type ChannelPlanInput, type AmazonProductJob } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
import { parseAmazonRenderedProduct, amazonProductAddress, amazonStoreAddress } from "./amazon-rendered.js";
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
// Preserve the selected ASIN and all public gallery-selection evidence.
const productProjection=(raw:unknown)=>AmazonRenderedProductSchema.parse(raw);
type Settings = Pick<ChannelPlanInput, "text" | "ocr" | "visionConfigFingerprint"> & { egressId: string };
/** The retained intent proves which page was fetched, with which capture settings, for which product. Queue names,
 * resource lanes and the run's stopping point are deployment policy that changes between runs and say nothing about
 * the page, so they are not part of the comparison; the discovery, the operation and session ids and every capture
 * setting still have to match exactly. */
const identityOnly = (intent: unknown) => {
  const v = intent as { job?: Record<string, unknown>; settings?: unknown };
  const job = v?.job ?? {};
  return { settings: v?.settings,
    job: { codec: job.codec, discovery: job.discovery, operationId: job.operationId, sessionId: job.sessionId } };
};
export interface AmazonProductPort { capture(job: AmazonProductJob, signal: AbortSignal): Promise<unknown> }

/** Capture only. Planning, each image transfer and browser close are other atomic calls. */
export class AmazonLiveProduct {
  constructor(readonly publication: RetainedPublication, readonly settings: Settings, readonly browser?: AmazonProductPort,
    readonly linkRequestIds: readonly string[] | ((job: AmazonProductJob) => Promise<boolean>) = []) {}
  private key(job: AmazonProductJob) { return `v3/amazon-products/${job.operationId}`; }
  private async derive(job: AmazonProductJob, raw: unknown) {
    const p = productProjection(raw), d = job.discovery;
    const authorized = typeof this.linkRequestIds === "function" ? await this.linkRequestIds(job) : this.linkRequestIds.includes(d.catalogId);
    const imported = authorized && d.source.producer.module === "amazon.link-list" && d.source.producer.implementationVersion === "amazon-link-batch/1";
    if (amazonProductAddress(d.entry.url).asin !== d.entry.listingId || p.asin !== d.entry.listingId || d.entry.variantId !== null || (!imported && (p.storeUrl === null || amazonStoreAddress(p.storeUrl).id !== amazonStoreAddress(d.scope.rootUrl).id)))
      throw Error("AMAZON.IDENTITY_UNVERIFIED");
    const identity = { listingId: p.asin, variantId: null };
    parseAmazonRenderedProduct(p, d.entry.url, identity);
    const owner = { schemaVersion: 1, requestId: d.catalogId, observationId: `amazon-${sha256(bytes([d.discoveryId, identity]))}`,
      brandId: d.scope.brandId, sourceId: d.scope.sourceId, ...identity };
    const encoded = bytes(p), { egressId, ...providers } = this.settings;
    const sourcePlan = ChannelPlanInputSchema.parse({ operationId: `plan-${sha256(bytes(job))}`, owner, channel: "amazon", parserVersion: "amazon-rendered/1",
      expectedUrl: d.entry.url, binding: { sessionId: job.sessionId, egressId }, ...providers,
      source: { schemaVersion: 1, artifactId: `source-${sha256(bytes(job))}`, observationId: owner.observationId, sourceId: owner.sourceId, ...identity,
        kind: "result-json", mediaType: "application/json", objectKey: `${this.key(job)}/projection.json`, byteSize: encoded.length, sha256: sha256(encoded),
        producer: { operationId: job.operationId, module: p.fetchedVia?.mode === "http" ? "amazon.http-projection" : "amazon.browser-projection", implementationVersion: "amazon-rendered/1" } } });
    return AmazonProductCaptureSchema.parse({ job, sourcePlan });
  }
  private async inspectProduct(raw: unknown, signal: AbortSignal) {
    const job = AmazonProductJobSchema.parse(raw), key = this.key(job);
    const intent = await this.publication.remote.read(`${key}/intent.json`, 65536, signal);
    // The retained page is reused whenever it was fetched for this same product with these same capture settings.
    if (intent && !equal(identityOnly(JSON.parse(Buffer.from(intent).toString())), identityOnly({ job, settings: this.settings })))
      throw Error("AMAZON.PRODUCT_POLICY_CONFLICT");
    const p = await this.publication.remote.read(`${key}/projection.json`, 4 * 1024 * 1024, signal);
    if (!p) return null;
    if (!intent) throw Error("AMAZON.PRODUCT_INTENT_MISSING");
    const product = productProjection(JSON.parse(Buffer.from(p).toString()));
    return { captured: await this.derive(job, product), product };
  }
  async inspect(raw: unknown, signal: AbortSignal) {
    return (await this.inspectProduct(raw, signal))?.captured ?? null;
  }
  /** Read the exact observed page URL from verified retained evidence. The original
   * expectedUrl and all historical input fingerprints stay unchanged. */
  async filePageUrl(raw: unknown, signal: AbortSignal) {
    const captured = AmazonProductCaptureSchema.parse(raw);
    const saved = await this.inspectProduct(captured.job, signal);
    // derive validates Amazon origin/ASIN and regenerates the source size/hash and
    // owner/session binding; equality ties this URL to this exact capture input.
    if (!saved || !equal(saved.captured, captured)) throw Error("AMAZON.CAPTURE_UNVERIFIED");
    return saved.product.url;
  }
  async capture(raw: unknown, signal: AbortSignal) {
    const job = AmazonProductJobSchema.parse(raw), old = await this.inspect(job, signal);
    if (old) return old;
    if (!this.browser) throw Error("AMAZON.CAPTURE_UNAVAILABLE");
    const key = this.key(job);
    if (await this.publication.remote.create(`${key}/intent.json`, bytes({ job, settings: this.settings }), "application/json", signal) !== "created")
      throw Error("AMAZON.CAPTURE_UNRESOLVED");
    const projection = productProjection(await this.browser.capture(job, signal));
    const result = await this.derive(job, projection);
    await this.publication.publish(result.sourcePlan.source.objectKey, bytes(projection), "application/json", signal);
    const confirmed = await this.inspect(job, signal);
    if (!confirmed || !equal(confirmed, result)) throw Error("AMAZON.CAPTURE_UNRESOLVED");
    return confirmed;
  }
}
