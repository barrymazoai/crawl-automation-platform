import { isDeepStrictEqual as equal } from "node:util";
import { DtcProductJobSchema, DtcProductCaptureSchema, DtcRenderedProductSchema, ChannelPlanInputSchema,
  type ChannelPlanInput, type DtcProductJob } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
import { parseDtcRenderedProduct, dtcAddress } from "./dtc-rendered.js";
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
// Preserve the selected URL and public gallery-selection evidence.
const productProjection=(raw:unknown)=>DtcRenderedProductSchema.parse(raw);
type Settings = Pick<ChannelPlanInput, "text" | "ocr" | "visionConfigFingerprint"> & { egressId: string };
export interface DtcProductPort { capture(job: DtcProductJob, signal: AbortSignal): Promise<unknown> }

/** Capture only. Planning, each image transfer and browser close are other atomic calls. */
export class DtcLiveProduct {
  constructor(readonly publication: RetainedPublication, readonly settings: Settings, readonly browser?: DtcProductPort) {}
  private key(job: DtcProductJob) { return `v3/dtc-products/${job.operationId}`; }
  private derive(job: DtcProductJob, raw: unknown) {
    const p = productProjection(raw), d = job.discovery;
    if (dtcAddress(d.entry.url).listingId !== d.entry.listingId || p.listingId !== d.entry.listingId || d.entry.variantId !== null || new URL(p.url).origin !== new URL(d.scope.rootUrl).origin)
      throw Error("DTC.IDENTITY_UNVERIFIED");
    const identity = { listingId: p.listingId, variantId: null };
    parseDtcRenderedProduct(p, d.entry.url, identity);
    const owner = { schemaVersion: 1, requestId: d.catalogId, observationId: `dtc-${sha256(bytes([d.discoveryId, identity]))}`,
      brandId: d.scope.brandId, sourceId: d.scope.sourceId, ...identity };
    const encoded = bytes(p), { egressId, ...providers } = this.settings;
    const sourcePlan = ChannelPlanInputSchema.parse({ operationId: `plan-${sha256(bytes(job))}`, owner, channel: "dtc", parserVersion: "dtc-rendered/1",
      expectedUrl: d.entry.url, binding: { sessionId: job.sessionId, egressId }, ...providers,
      source: { schemaVersion: 1, artifactId: `source-${sha256(bytes(job))}`, observationId: owner.observationId, sourceId: owner.sourceId, ...identity,
        kind: "result-json", mediaType: "application/json", objectKey: `${this.key(job)}/projection.json`, byteSize: encoded.length, sha256: sha256(encoded),
        producer: { operationId: job.operationId, module: "dtc.browser-projection", implementationVersion: "dtc-rendered/1" } } });
    return DtcProductCaptureSchema.parse({ job, sourcePlan });
  }
  async inspect(raw: unknown, signal: AbortSignal) {
    const job = DtcProductJobSchema.parse(raw), key = this.key(job);
    const intent = await this.publication.remote.read(`${key}/intent.json`, 65536, signal);
    if (intent && !equal(JSON.parse(Buffer.from(intent).toString()), { job, settings: this.settings })) throw Error("DTC.PRODUCT_POLICY_CONFLICT");
    const p = await this.publication.remote.read(`${key}/projection.json`, 4 * 1024 * 1024, signal);
    if (!p) return null;
    if (!intent) throw Error("DTC.PRODUCT_INTENT_MISSING");
    return this.derive(job, JSON.parse(Buffer.from(p).toString()));
  }
  async capture(raw: unknown, signal: AbortSignal) {
    const job = DtcProductJobSchema.parse(raw), old = await this.inspect(job, signal);
    if (old) return old;
    if (!this.browser) throw Error("DTC.CAPTURE_UNAVAILABLE");
    const key = this.key(job);
    if (await this.publication.remote.create(`${key}/intent.json`, bytes({ job, settings: this.settings }), "application/json", signal) !== "created")
      throw Error("DTC.CAPTURE_UNRESOLVED");
    const projection = productProjection(await this.browser.capture(job, signal));
    const result = this.derive(job, projection);
    await this.publication.publish(result.sourcePlan.source.objectKey, bytes(projection), "application/json", signal);
    const confirmed = await this.inspect(job, signal);
    if (!confirmed || !equal(confirmed, result)) throw Error("DTC.CAPTURE_UNRESOLVED");
    return confirmed;
  }
}
