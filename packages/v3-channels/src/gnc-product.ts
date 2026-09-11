import { isDeepStrictEqual as equal } from "node:util";
import { ArtifactRefSchema, GncParsedEvidenceSchema, GncProductInputSchema, GncProductPrepareSchema, GncProductPlanSchema,
  GncProductPrepareOutcomeSchema, PagePrepareInputSchema, FileAcquireInputSchema, acquisitionFingerprintMaterial, ReviewRecordSchema,
  type FileAcquireInput, type GncProductInput, type GncProductPlan, type GncProductPrepareOutcome, type GncAcquiredRecord, type GncProductEvidence, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { sha256, verifyBytes } from "@crawl-automation/v3-artifacts";
import { PAGE_CONFIG_FINGERPRINT, FILE_CONFIG_FINGERPRINT, acquiredImageId, StaticSourcesSchema, permittedUrl } from "@crawl-automation/v3-acquisition";
import { GncCaptureEvidence } from "./gnc-handoff.js";
import { parseGncProduct } from "./gnc.js";
const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
const LIMIT = 8 * 1024 * 1024;
export const gncProductKey = (input: GncProductInput) => `v3/gnc-products/${input.operationId}/plan.json`;
export const gncProductFingerprint = (input: GncProductInput) => sha256(encode(GncProductInputSchema.parse(input)));
/** Stable per-product operations. No URL rewriting, source dropping or model execution. */
function build(input: GncProductInput, capture: GncAcquiredRecord, data: GncProductEvidence, parsed?: GncProductPlan["parsed"]) {
  const id = (role: string) => `gncp-${sha256(encode([input.operationId, role]))}`;
  // Only SKU-scoped fragments; the full page remains upstream evidence, not nutrition text containing recommendations.
  const html = [data.factsHtml, data.detailsHtml].filter((s): s is string => Boolean(s?.trim())).map(s => `<section>${s}</section>`).join("\n");
  const bytes = Buffer.from(html);
  const fragment = html ? ArtifactRefSchema.parse({ schemaVersion: 1, artifactId: id("fragment"),
    observationId: input.task.owner.observationId, sourceId: input.task.owner.sourceId, listingId: input.task.owner.listingId, variantId: input.task.owner.variantId,
    kind: "source-html", mediaType: "text/html", objectKey: `v3/gnc-products/${input.operationId}/product.html`, sha256: sha256(bytes), byteSize: bytes.length,
    producer: { operationId: id("prepare"), module: "gnc.product-input", implementationVersion: "gnc-product-input/1" } }) : null;
  const sources: GncProductPlan["manifest"]["sources"] = [];
  if (fragment) {
    const raw = PagePrepareInputSchema.parse({ ...input.task.owner, operationId: id("page"), module: "page.prepare", implementationVersion: "1",
      policyVersion: "1", configFingerprint: PAGE_CONFIG_FINGERPRINT, page: fragment, inputFingerprint: "0".repeat(64) });
    const page = PagePrepareInputSchema.parse({ ...raw, inputFingerprint: sha256(Buffer.from(acquisitionFingerprintMaterial(raw))) });
    sources.push({ id: "page", kind: "page", required: false, plan: { page, textOperationId: id("text"), text: input.text } });
  }
  for (const [index] of data.imageCandidates.entries()) {
    const raw = { ...input.task.owner, operationId: id(`file-${index}`), module: "file.acquire" as const, implementationVersion: "1",
      policyVersion: "1", configFingerprint: FILE_CONFIG_FINGERPRINT, resourceId: id(`resource-${index}`), binding: input.task.capture.binding,
      expectedSha256: null, inputFingerprint: "0".repeat(64) };
    const acquire = FileAcquireInputSchema.parse({ ...raw, inputFingerprint: sha256(Buffer.from(acquisitionFingerprintMaterial(raw))) });
    sources.push({ id: `image-${index}`, kind: "file-image", required: false, plan: { imageId: acquiredImageId(acquire.operationId), acquire,
      ocrOperationId: id(`ocr-${index}`), ocr: input.ocr }, visionOperationId: id(`vision-${index}`), configFingerprint: input.visionConfigFingerprint });
  }
  if (!sources.length) throw Error("GNC.NO_PRODUCT_SOURCES");
  if (sources.length > 100 || bytes.length > 2 * 1024 * 1024) throw Error("GNC.PRODUCT_SOURCE_LIMIT");
  const ops = sources.flatMap(s => s.kind === "page" ? [s.plan.page.operationId, s.plan.textOperationId] : s.kind === "file-image" ? [s.plan.acquire.operationId, s.plan.ocrOperationId, s.visionOperationId] : []);
  if (ops.includes(input.task.capture.operationId) || id("prepare") === input.task.capture.operationId) throw Error("GNC.IDENTITY_CONFLICT");
  const plan = GncProductPlanSchema.parse({ codec: "gnc-product-plan/1", input, capture, fragment, ...(parsed ? { parsed } : {}),
    manifest: { operationId: input.operationId, observation: input.task.owner, sources } });
  return { plan, bytes };
}
/** Preparation and immutable plan evidence only. No source network, OCR, Codex or product collection port. */
export class GncProductPlans {
  constructor(private readonly evidence: GncCaptureEvidence) {}
  private async derive(input: GncProductInput, signal: AbortSignal) {
    const capture = await this.evidence.inspect(input.task, signal); if (!capture) throw Error("GNC.NOT_DURABLE");
    if (input.parseVersion) {
      const task = input.task.capture; if (task.kind !== "product") throw Error("GNC.IDENTITY_CONFLICT");
      const html = await this.evidence.deps.remote.read(capture.source.objectKey, LIMIT, signal);
      if (!html) throw Error("GNC.NOT_DURABLE"); verifyBytes(capture.source, html, LIMIT);
      signal.throwIfAborted();
      // This version is pinned to the v2 parser semantics. Future changes need a new version/path.
      const data = parseGncProduct(new TextDecoder("utf-8", { fatal: true }).decode(html), task.url, task.sku);
      const parsedBytes = encode({ codec: "gnc-product-reparse/1", parserVersion: input.parseVersion, capture,
        parsed: GncParsedEvidenceSchema.parse({ kind: "product", data, network: input.task.network }) });
      if (parsedBytes.length > LIMIT) throw Error("GNC.PRODUCT_SOURCE_LIMIT");
      const parsed = ArtifactRefSchema.parse({ ...capture.evidence, artifactId: `gncp-${sha256(encode([input.operationId, "parsed"]))}`,
        objectKey: `v3/gnc-products/${input.operationId}/parsed.json`, sha256: sha256(parsedBytes), byteSize: parsedBytes.length,
        producer: { operationId: input.operationId, module: "gnc.product-input", implementationVersion: input.parseVersion } });
      if (parsed.kind !== "result-json") throw Error("GNC.IDENTITY_CONFLICT");
      return { ...build(input, capture, data, parsed), data, parsedBytes };
    }
    const bytes = await this.evidence.deps.remote.read(capture.evidence.objectKey, LIMIT, signal);
    if (!bytes) throw Error("GNC.NOT_DURABLE"); verifyBytes(capture.evidence, bytes, LIMIT);
    const parsed = GncParsedEvidenceSchema.parse(decode(bytes)); if (parsed.kind !== "product") throw Error("GNC.IDENTITY_CONFLICT");
    return { ...build(input, capture, parsed.data), data: parsed.data, parsedBytes: null };
  }
  async inspect(raw: GncProductInput, signal: AbortSignal): Promise<GncProductPlan | null> {
    const input = GncProductInputSchema.parse(raw), prior = await this.evidence.deps.remote.read(gncProductKey(input), LIMIT, signal);
    if (!prior) return null;
    const { plan } = await this.derive(input, signal);
    if (!equal(GncProductPlanSchema.parse(decode(prior)), plan)) throw Error("GNC.PLAN_CONFLICT");
    if (plan.parsed) {
      const bytes = await this.evidence.deps.remote.read(plan.parsed.objectKey, LIMIT, signal);
      if (!bytes) throw Error("GNC.NOT_DURABLE"); verifyBytes(plan.parsed, bytes, LIMIT);
    }
    if (plan.fragment) {
      const html = await this.evidence.deps.remote.read(plan.fragment.objectKey, 2 * 1024 * 1024, signal);
      if (!html) throw Error("GNC.NOT_DURABLE"); verifyBytes(plan.fragment, html, 2 * 1024 * 1024);
    }
    return plan;
  }
  /** Private operator-side export for the existing direct file Worker. Never send this catalog to Temporal. */
  async directFileSources(raw: GncProductInput, allowedOrigins: string[], expiresAt: string, signal: AbortSignal) {
    const input = GncProductInputSchema.parse(raw);
    if (input.task.network.mode !== "direct") throw Error("NETWORK.CAPABILITY_UNAVAILABLE");
    const plan = await this.inspect(input, signal); if (!plan) throw Error("GNC.NOT_DURABLE");
    const { data } = await this.derive(input, signal);
    const files = plan.manifest.sources.filter(s => s.kind === "file-image");
    if (files.length !== data.imageCandidates.length) throw Error("GNC.PLAN_CONFLICT");
    const sources = StaticSourcesSchema.parse(files.map((source, index) => ({ owner: input.task.owner, resourceId: source.plan.acquire.resourceId,
      binding: source.plan.acquire.binding, url: data.imageCandidates[index]!.url, allowedOrigins, expiresAt })));
    for (const source of sources) {
      permittedUrl(source.url, source.allowedOrigins);
      for (const origin of source.allowedOrigins) if (permittedUrl(origin, [origin]).origin !== origin) throw Error("SOURCE.ORIGIN_BLOCKED");
    }
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw Error("SOURCE.SESSION_UNAVAILABLE");
    return sources;
  }
  /** Resolve one exact published file task, read-only. No URL is accepted from the caller. */
  async fileSource(input: GncProductInput, raw: FileAcquireInput, signal: AbortSignal): Promise<string> {
    const requested = FileAcquireInputSchema.parse(raw), plan = await this.inspect(input, signal);
    if (!plan) throw Error("GNC.NOT_DURABLE");
    const files = plan.manifest.sources.filter(s => s.kind === "file-image");
    const index = files.findIndex(s => equal(s.plan.acquire, requested));
    if (index < 0) throw Error("SOURCE.SESSION_MISMATCH");
    const { data } = await this.derive(GncProductInputSchema.parse(input), signal);
    if (data.imageCandidates.length !== files.length) throw Error("GNC.PLAN_CONFLICT");
    return data.imageCandidates[index]!.url;
  }
  private result(plan: GncProductPlan): GncProductPrepareOutcome {
    return { status: "prepared", operationId: plan.input.operationId, inputFingerprint: gncProductFingerprint(plan.input),
      evidenceKey: gncProductKey(plan.input), manifest: plan.manifest };
  }
  private async priorReview(input: GncProductInput) {
    const id = `gncp-${gncProductFingerprint(input)}`, raw = await this.evidence.deps.reviews.read(id);
    if (!raw) return null;
    const r = ReviewRecordSchema.parse(raw);
    if (r.reviewId !== id || r.failure.operationId !== input.operationId || r.failure.inputFingerprint !== gncProductFingerprint(input) ||
      r.failure.stage !== "gnc.product-input" || r.failure.evidenceKey !== `gnc-product-reviews/${id}.json` || !equal(r.observation, input.task.owner) || !equal(r.rawError.details, { input })) throw Error("GNC.REVIEW_UNVERIFIED");
    return GncProductPrepareOutcomeSchema.parse({ status: "review", operationId: input.operationId, reviewId: id,
      code: r.failure.code, evidenceKey: r.failure.evidenceKey, automaticRetry: false });
  }
  async run(raw: unknown, signal: AbortSignal): Promise<GncProductPrepareOutcome> {
    const { input, receipt } = GncProductPrepareSchema.parse(raw), e = this.evidence;
    try {
      signal.throwIfAborted();
      const capture = await e.inspect(input.task, signal);
      if (!capture) throw Error("GNC.NOT_DURABLE");
      if (receipt && !equal(receipt, e.receipt(capture))) throw Error("GNC.EVIDENCE_CONFLICT");
      const old = await this.inspect(input, signal); if (old) return this.result(old);
      const review = await this.priorReview(input); if (review) return review;
      const { plan, bytes, parsedBytes } = await this.derive(input, signal), key = gncProductKey(input), encoded = encode(plan);
      if (encoded.length > LIMIT) throw Error("GNC.PRODUCT_SOURCE_LIMIT");
      if (plan.parsed && parsedBytes) {
        await e.retain(plan.parsed.objectKey, parsedBytes, "application/json", signal);
        await e.publish(plan.parsed.objectKey, parsedBytes, "application/json", signal);
      }
      if (plan.fragment) {
        await e.retain(plan.fragment.objectKey, bytes, "text/html", signal);
        await e.publish(plan.fragment.objectKey, bytes, "text/html", signal);
      }
      await e.retain(key, encoded, "application/json", signal); await e.publish(key, encoded, "application/json", signal);
      const verified = await this.inspect(input, signal); if (!verified) throw Error("GNC.NOT_DURABLE"); return this.result(verified);
    } catch (error) {
      signal.throwIfAborted();
      const prior = await this.priorReview(input); if (prior) return prior;
      const rawCode = error instanceof Error ? ("code" in error ? String(error.code) : error.message) : "";
      const code = /^(GNC|ARTIFACT)\.[A-Z_]+$/.test(rawCode) ? rawCode : "GNC.PLAN_UNRESOLVED";
      const id = `gncp-${gncProductFingerprint(input)}`, key = `gnc-product-reviews/${id}.json`;
      const r = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: id, occurredAt: new Date().toISOString(), observation: input.task.owner,
        failure: { schemaVersion: 1, requestId: input.task.owner.requestId, observationId: input.task.owner.observationId, operationId: input.operationId,
          inputFingerprint: gncProductFingerprint(input), stage: "gnc.product-input", category: "PROCESSING", code, executionFact: "unknown", evidenceKey: key, blockedBy: null, automaticRetry: false },
        rawError: { name: "GncProductPlanFailure", message: code, stack: null, details: { input } }, candidate: null, inspection: { kind: "none" } });
      const keep = AbortSignal.timeout(10000);
      await e.deps.local.create(key, encode(r), "application/json", keep);
      const bytes = await e.deps.local.read(key, LIMIT, keep); if (!bytes) throw Error("GNC.REVIEW_UNVERIFIED");
      const saved: ReviewRecord = ReviewRecordSchema.parse(decode(bytes));
      if (saved.reviewId !== id || !equal(saved.rawError.details, { input })) throw Error("GNC.REVIEW_UNVERIFIED");
      try { await e.deps.reviews.append(saved); } catch { /* Read back the same immutable Review, not a second attempt. */ }
      const confirmed = await e.deps.reviews.read(id);
      if (!confirmed || !equal(ReviewRecordSchema.parse(confirmed), saved)) throw Error("GNC.REVIEW_UNVERIFIED");
      return (await this.priorReview(input))!;
    }
  }
}
