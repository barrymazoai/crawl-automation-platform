import { isDeepStrictEqual as equal } from "node:util";
import { SwansonProductJobSchema, SwansonProductCaptureSchema, SwansonRenderedProductSchema, ChannelPlanInputSchema,
  type ChannelPlanInput, type SwansonProductJob } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
import { parseSwansonRenderedProduct, swansonProductAddress } from "./swanson-rendered.js";
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
// Family option evidence has its own retained receipt. Keep the product projection
// compatible with the already deployed independent label consumers.
const productProjection=(raw:unknown)=>{const {variantPicker: _options,...p}=SwansonRenderedProductSchema.parse(raw);return p;};
type Settings = Pick<ChannelPlanInput, "text" | "ocr" | "visionConfigFingerprint"> & { egressId: string };
export interface SwansonProductPort { capture(job: SwansonProductJob, signal: AbortSignal): Promise<unknown> }

/** Capture only. Planning, each image transfer and browser close are other atomic calls. */
export class SwansonLiveProduct {
  constructor(readonly publication: RetainedPublication, readonly settings: Settings, readonly browser?: SwansonProductPort) {}
  private key(job: SwansonProductJob) { return `v3/swanson-products/${job.operationId}`; }
  private derive(job: SwansonProductJob, raw: unknown) {
    const p = productProjection(raw), d = job.discovery;
    if (swansonProductAddress(d.entry.url).handle !== d.entry.listingId || p.selectedForms.length !== 1 || p.selectedForms[0]!.variantIds.length !== 1)
      throw Error("SWANSON.IDENTITY_UNVERIFIED");
    const selected = p.selectedForms[0]!, identity = { listingId: selected.productId, variantId: selected.variantIds[0]! };
    if(d.entry.variantId!==null&&d.entry.variantId!==identity.variantId)throw Error("SWANSON.VARIANT_CONFLICT");
    parseSwansonRenderedProduct(p, d.entry.url, identity);
    const owner = { schemaVersion: 1, requestId: d.catalogId, observationId: `swanson-${sha256(bytes([d.discoveryId, identity]))}`,
      brandId: d.scope.brandId, sourceId: d.scope.sourceId, ...identity };
    const encoded = bytes(p), { egressId, ...providers } = this.settings;
    const sourcePlan = ChannelPlanInputSchema.parse({ operationId: `plan-${sha256(bytes(job))}`, owner, channel: "swanson", parserVersion: "swanson-rendered/1",
      expectedUrl: d.entry.url, binding: { sessionId: job.sessionId, egressId }, ...providers,
      source: { schemaVersion: 1, artifactId: `source-${sha256(bytes(job))}`, observationId: owner.observationId, sourceId: owner.sourceId, ...identity,
        kind: "result-json", mediaType: "application/json", objectKey: `${this.key(job)}/projection.json`, byteSize: encoded.length, sha256: sha256(encoded),
        producer: { operationId: job.operationId, module: "swanson.browser-projection", implementationVersion: "swanson-rendered/1" } } });
    return SwansonProductCaptureSchema.parse({ job, sourcePlan });
  }
  async inspect(raw: unknown, signal: AbortSignal) {
    const job = SwansonProductJobSchema.parse(raw), key = this.key(job);
    const intent = await this.publication.remote.read(`${key}/intent.json`, 65536, signal);
    if (intent && !equal(JSON.parse(Buffer.from(intent).toString()), { job, settings: this.settings })) throw Error("SWANSON.PRODUCT_POLICY_CONFLICT");
    const p = await this.publication.remote.read(`${key}/projection.json`, 4 * 1024 * 1024, signal);
    if (!p) return null;
    if (!intent) throw Error("SWANSON.PRODUCT_INTENT_MISSING");
    return this.derive(job, JSON.parse(Buffer.from(p).toString()));
  }
  async capture(raw: unknown, signal: AbortSignal) {
    const job = SwansonProductJobSchema.parse(raw), old = await this.inspect(job, signal);
    if (old) return old;
    if (!this.browser) throw Error("SWANSON.CAPTURE_UNAVAILABLE");
    const key = this.key(job);
    if (await this.publication.remote.create(`${key}/intent.json`, bytes({ job, settings: this.settings }), "application/json", signal) !== "created")
      throw Error("SWANSON.CAPTURE_UNRESOLVED");
    const projection = productProjection(await this.browser.capture(job, signal));
    const result = this.derive(job, projection);
    await this.publication.publish(result.sourcePlan.source.objectKey, bytes(projection), "application/json", signal);
    const confirmed = await this.inspect(job, signal);
    if (!confirmed || !equal(confirmed, result)) throw Error("SWANSON.CAPTURE_UNRESOLVED");
    return confirmed;
  }
}
