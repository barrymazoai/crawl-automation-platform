import { isDeepStrictEqual as equal } from "node:util";
import { ArtifactRefSchema, ChannelPlanInputSchema, ChannelProductPlanSchema, ChannelPlanOutcomeSchema, FileAcquireInputSchema,
  PagePrepareInputSchema, acquisitionFingerprintMaterial, ReviewRecordSchema, type ChannelPlanInput, type ChannelProductPlan,
  type ChannelPlanOutcome, type FileAcquireInput, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { sha256, verifyBytes, RetainedPublication, type ArtifactResolver } from "@crawl-automation/v3-artifacts";
import { acquiredImageId, FILE_CONFIG_FINGERPRINT, PAGE_CONFIG_FINGERPRINT } from "@crawl-automation/v3-acquisition";
import { parseDtcRenderedProduct } from "./dtc-rendered.js";
import { parseAmazonRenderedProduct } from "./amazon-rendered.js";
import { parseSwansonRenderedProduct } from "./swanson-rendered.js";
import { ChannelError } from "./html-evidence.js";
const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
const LIMIT = 8 * 1024 * 1024;
export const channelPlanKey = (i: ChannelPlanInput) => `v3/channel-plans/${i.operationId}/plan.json`;
export const channelPlanFingerprint = (i: ChannelPlanInput) => sha256(encode(ChannelPlanInputSchema.parse(i)));
type Reviews = { read(id: string): Promise<ReviewRecord | null>; append(record: ReviewRecord): Promise<unknown> };

/** Compile one retained product projection into independent page/file tasks. No crawler, OCR or model port. */
export class ChannelProductPlans {
  constructor(readonly publication: RetainedPublication, private readonly resolver: Pick<ArtifactResolver, "resolve">,
    private readonly reviews: Reviews) {}
  private async derive(input: ChannelPlanInput, signal: AbortSignal) {
    const source = await this.resolver.resolve(input.source, input.owner, signal);
    if (!equal(source.ref, input.source)) throw new ChannelError("CHANNEL.SOURCE_CONFLICT");
    verifyBytes(input.source, source.bytes, 4 * 1024 * 1024);
    const product = (input.channel === "dtc" ? parseDtcRenderedProduct : input.channel === "amazon" ? parseAmazonRenderedProduct : parseSwansonRenderedProduct)(decode(source.bytes), input.expectedUrl, input.owner);
    const id = (role: string) => `chp-${sha256(encode([input.operationId, role]))}`;
    // Escaped DOM text, explicitly derived; never claimed to be the original full-page HTML.
    const html = [...product.factsCandidates.filter(f => f.scope === "selected-product").map(f => f.html), product.detailsHtml].filter(Boolean).join("\n");
    const bytes = Buffer.from(html);
    const fragment = html ? ArtifactRefSchema.parse({ schemaVersion: 1, artifactId: id("fragment"),
      observationId: input.owner.observationId, sourceId: input.owner.sourceId, listingId: input.owner.listingId, variantId: input.owner.variantId,
      kind: "source-html", mediaType: "text/html", objectKey: `v3/channel-plans/${input.operationId}/derived.html`, byteSize: bytes.length, sha256: sha256(bytes),
      producer: { operationId: input.operationId, module: "channel.product-input", implementationVersion: "channel-plan/1" } }) : null;
    const sources: ChannelProductPlan["manifest"]["sources"] = [], files: ChannelProductPlan["files"] = [];
    if (fragment) {
      const raw = PagePrepareInputSchema.parse({ ...input.owner, operationId: id("page"), module: "page.prepare", implementationVersion: "1",
        policyVersion: "1", configFingerprint: PAGE_CONFIG_FINGERPRINT, page: fragment, inputFingerprint: "0".repeat(64) });
      const page = PagePrepareInputSchema.parse({ ...raw, inputFingerprint: sha256(Buffer.from(acquisitionFingerprintMaterial(raw))) });
      sources.push({ id: "page", kind: "page", required: false, plan: { page, textOperationId: id("text"), text: input.text } });
    }
    for (const [index, image] of product.imageCandidates.entries()) {
      if (image.variantId !== input.owner.variantId) throw new ChannelError("CHANNEL.VARIANT_CONFLICT");
      const raw = FileAcquireInputSchema.parse({ ...input.owner, operationId: id(`file-${index}`), module: "file.acquire", implementationVersion: "1",
        policyVersion: "1", configFingerprint: FILE_CONFIG_FINGERPRINT, resourceId: id(`resource-${index}`), binding: input.binding,
        expectedSha256: null, inputFingerprint: "0".repeat(64) });
      const acquire = FileAcquireInputSchema.parse({ ...raw, inputFingerprint: sha256(Buffer.from(acquisitionFingerprintMaterial(raw))) });
      sources.push({ id: `image-${index}`, kind: "file-image", required: false, plan: { imageId: acquiredImageId(acquire.operationId), acquire,
        ocrOperationId: id(`ocr-${index}`), ocr: input.ocr }, visionOperationId: id(`vision-${index}`), configFingerprint: input.visionConfigFingerprint });
      files.push({ resourceId: acquire.resourceId, url: image.url });
    }
    if (!sources.length) throw new ChannelError("CHANNEL.NO_PRODUCT_SOURCES");
    const plan = ChannelProductPlanSchema.parse({ codec: "channel-plan/1", input, product, fragment, files,
      manifest: { operationId: input.operationId, observation: input.owner, sources } });
    const ops = sources.flatMap(s => s.kind === "file-image" ? [s.plan.acquire.operationId, s.plan.ocrOperationId, s.visionOperationId] :
      s.kind === "page" ? [s.plan.page.operationId, s.plan.textOperationId] : []);
    if (ops.includes(input.source.producer.operationId)) throw new ChannelError("CHANNEL.OPERATION_CONFLICT");
    if (encode(plan).length > LIMIT || bytes.length > 2 * 1024 * 1024) throw new ChannelError("CHANNEL.OUTPUT_LIMIT");
    return { plan, bytes };
  }
  async inspect(raw: unknown, signal: AbortSignal): Promise<ChannelProductPlan | null> {
    const input = ChannelPlanInputSchema.parse(raw), saved = await this.publication.remote.read(channelPlanKey(input), LIMIT, signal);
    if (!saved) return null;
    const { plan } = await this.derive(input, signal);
    if (!equal(ChannelProductPlanSchema.parse(decode(saved)), plan)) throw new ChannelError("CHANNEL.PLAN_CONFLICT");
    if (plan.fragment) {
      const bytes = await this.publication.remote.read(plan.fragment.objectKey, plan.fragment.byteSize, signal);
      if (!bytes) throw new ChannelError("CHANNEL.NOT_DURABLE");
      verifyBytes(plan.fragment, bytes, 2 * 1024 * 1024);
    }
    // Publication is only durable if its original input is available beyond this worker's local disk.
    const source = await this.publication.remote.read(input.source.objectKey, input.source.byteSize, signal);
    if (!source) throw new ChannelError("CHANNEL.NOT_DURABLE");
    verifyBytes(input.source, source, 4 * 1024 * 1024);
    return plan;
  }
  private result(plan: ChannelProductPlan): ChannelPlanOutcome {
    return ChannelPlanOutcomeSchema.parse({ status: "prepared", operationId: plan.input.operationId,
      inputFingerprint: channelPlanFingerprint(plan.input), evidenceKey: channelPlanKey(plan.input), manifest: plan.manifest });
  }
  /** Private file acquisition lookup: only a task from the exact durable plan can obtain its URL. */
  async fileSource(input: ChannelPlanInput, raw: FileAcquireInput, signal: AbortSignal) {
    const requested = FileAcquireInputSchema.parse(raw), plan = await this.inspect(input, signal);
    if (!plan || !plan.manifest.sources.some(s => s.kind === "file-image" && equal(s.plan.acquire, requested))) throw new ChannelError("SOURCE.SESSION_MISMATCH");
    const source = plan.files.find(f => f.resourceId === requested.resourceId);
    if (!source) throw new ChannelError("SOURCE.SESSION_MISMATCH");
    return source.url;
  }
  private async prior(input: ChannelPlanInput): Promise<ChannelPlanOutcome | null> {
    const id = `chp-${channelPlanFingerprint(input)}`, raw = await this.reviews.read(id);
    if (!raw) return null;
    const r = ReviewRecordSchema.parse(raw);
    if (r.reviewId !== id || !equal(r.observation, input.owner) || r.failure.operationId !== input.operationId ||
      r.failure.inputFingerprint !== channelPlanFingerprint(input) || r.failure.stage !== "channel.product-input" ||
      r.failure.evidenceKey !== `v3/channel-plan-reviews/${id}.json` || !equal(r.rawError.details, { input })) throw new ChannelError("CHANNEL.REVIEW_UNVERIFIED");
    return { status: "review", operationId: input.operationId, reviewId: id, evidenceKey: r.failure.evidenceKey, code: r.failure.code, automaticRetry: false };
  }
  async run(raw: unknown, signal: AbortSignal): Promise<ChannelPlanOutcome> {
    const input = ChannelPlanInputSchema.parse(raw);
    const prior = await this.prior(input); if (prior) return prior; // passive Reviews are never replayed
    try {
      signal.throwIfAborted();
      const old = await this.inspect(input, signal); if (old) return this.result(old);
      const { plan, bytes } = await this.derive(input, signal), key = channelPlanKey(input), encoded = encode(plan);
      const retain = AbortSignal.timeout(10000);
      if (plan.fragment) await this.publication.retain(plan.fragment.objectKey, bytes, "text/html", retain);
      await this.publication.retain(key, encoded, "application/json", retain);
      const source = await this.publication.remote.read(input.source.objectKey, input.source.byteSize, signal);
      if (!source) throw new ChannelError("CHANNEL.NOT_DURABLE");
      verifyBytes(input.source, source, 4 * 1024 * 1024);
      if (plan.fragment) await this.publication.publish(plan.fragment.objectKey, bytes, "text/html", signal);
      await this.publication.publish(key, encoded, "application/json", signal);
      const confirmed = await this.inspect(input, signal);
      if (!confirmed) throw new ChannelError("CHANNEL.NOT_DURABLE");
      return this.result(confirmed);
    } catch (error) {
      // Lost acknowledgements must not turn an already verified completion into a false processing failure.
      if (!signal.aborted) try { const complete = await this.inspect(input, AbortSignal.timeout(10000)); if (complete) return this.result(complete); } catch { /* read only */ }
      const message = error instanceof Error ? error.message : "";
      const code = signal.aborted ? "CHANNEL.CANCELLED" : /^(CHANNEL|SWANSON|AMAZON|DTC|ARTIFACT)\.[A-Z_]+$/.test(message) ? message : "CHANNEL.PLAN_UNRESOLVED";
      const id = `chp-${channelPlanFingerprint(input)}`, key = `v3/channel-plan-reviews/${id}.json`, keep = AbortSignal.timeout(10000);
      const proposed = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: id, occurredAt: new Date().toISOString(), observation: input.owner,
        failure: { schemaVersion: 1, requestId: input.owner.requestId, observationId: input.owner.observationId, operationId: input.operationId,
          inputFingerprint: channelPlanFingerprint(input), stage: "channel.product-input", category: code.startsWith("ARTIFACT.") || code === "CHANNEL.NOT_DURABLE" ? "ARTIFACT" : "PROCESSING",
          code, executionFact: "unknown", evidenceKey: key, blockedBy: null, automaticRetry: false },
        rawError: { name: "ChannelPlanFailure", message: code, stack: null, details: { input } }, candidate: null, inspection: { kind: "none" } });
      await this.publication.local.create(key, encode(proposed), "application/json", keep);
      const saved = await this.publication.local.read(key, LIMIT, keep);
      if (!saved) throw new ChannelError("CHANNEL.REVIEW_UNVERIFIED");
      const record = ReviewRecordSchema.parse(decode(saved));
      if (record.reviewId !== id || !equal(record.rawError.details, { input })) throw new ChannelError("CHANNEL.REVIEW_UNVERIFIED");
      try { await this.reviews.append(record); } catch { /* read back the same ID */ }
      if (!equal(await this.reviews.read(id), record)) throw new ChannelError("CHANNEL.REVIEW_UNVERIFIED");
      return (await this.prior(input))!;
    }
  }
}
