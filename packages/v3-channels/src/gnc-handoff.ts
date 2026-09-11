import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { ArtifactRefSchema, assertArtifactBelongsTo, GncAcquireInputSchema, GncExecutionIntentSchema, GncReceivedRecordSchema,
  GncAcquiredRecordSchema, GncParsedEvidenceSchema, ReviewRecordSchema, type GncAcquireInput, type GncAcquireOutcome,
  type GncReceivedRecord, type GncAcquiredRecord, type ArtifactRef, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { sha256, verifyBytes, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { GncAdapter, GncError, GNC_POLICY } from "./gnc.js";

const JSON_LIMIT = 8 * 1024 * 1024, MANIFEST_LIMIT = 65536;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
export const gncFingerprint = (input: GncAcquireInput) => sha256(encode(GncAcquireInputSchema.parse(input)));
export const gncKeys = (input: GncAcquireInput) => {
  const root = `v3/gnc/${input.capture.operationId}`;
  return { intent: `${root}/execution.json`, source: `${root}/source.html`, received: `${root}/received.json`,
    evidence: `${root}/evidence.json`, completion: `${root}/completion.json` };
};
type Dependencies = { local: ObjectStore; remote: ObjectStore;
  reviews: { read(id: string): Promise<ReviewRecord | null>; append(record: ReviewRecord): Promise<unknown> } };
function artifact(input: GncAcquireInput, kind: "source" | "evidence", bytes: Uint8Array): ArtifactRef {
  const owner = input.owner;
  return ArtifactRefSchema.parse({ schemaVersion: 1, artifactId: `gnc-${kind}-${sha256(Buffer.from(input.capture.operationId))}`,
    observationId: owner.observationId, sourceId: owner.sourceId, listingId: owner.listingId, variantId: owner.variantId,
    kind: kind === "source" ? "source-html" : "result-json", mediaType: kind === "source" ? "text/html" : "application/json",
    objectKey: gncKeys(input)[kind], byteSize: bytes.length, sha256: sha256(bytes),
    producer: { operationId: input.capture.operationId, module: "gnc.capture", implementationVersion: input.implementationVersion } });
}
/** Storage/reconciliation only: no page reader, browser or parser capability. */
export class GncCaptureEvidence {
  constructor(readonly deps: Dependencies) {}
  private check(input: GncAcquireInput, record: GncReceivedRecord | GncAcquiredRecord) {
    if (!equal(record.input, input)) throw new GncError("GNC.EVIDENCE_CONFLICT");
    for (const [name, ref] of [["source", record.source], ...("evidence" in record ? [["evidence", record.evidence] as const] : [])] as const) {
      assertArtifactBelongsTo(ref, input.owner);
      const expected = artifact(input, name as "source" | "evidence", Buffer.from("x"));
      for (const field of ["artifactId", "objectKey", "kind", "mediaType"] as const) if (ref[field] !== expected[field]) throw new GncError("GNC.EVIDENCE_CONFLICT");
      if (!equal(ref.producer, expected.producer)) throw new GncError("GNC.EVIDENCE_CONFLICT");
    }
  }
  private async intent(input: GncAcquireInput, nonce: string, signal: AbortSignal) {
    const raw = await this.deps.remote.read(gncKeys(input).intent, MANIFEST_LIMIT, signal);
    if (!raw || !equal(GncExecutionIntentSchema.parse(decode(raw)), { input, nonce })) throw new GncError("GNC.EXECUTION_UNKNOWN");
  }
  async retain(key: string, bytes: Uint8Array, media: string, signal: AbortSignal) {
    await this.deps.local.create(key, bytes, media, signal);
    const saved = await this.deps.local.read(key, Math.max(bytes.length, 1), signal);
    if (!saved || sha256(saved) !== sha256(bytes)) throw new GncError("GNC.LOCAL_UNVERIFIED");
  }
  /** Each data PUT has local+shared one-shot markers. Existing identical bytes need GET only. */
  async publish(key: string, bytes: Uint8Array, media: string, signal: AbortSignal) {
    const verify = (actual: Uint8Array | null) => {
      if (!actual || sha256(actual) !== sha256(bytes)) throw new GncError("GNC.PUBLICATION_UNKNOWN");
    };
    const existing = await this.deps.remote.read(key, Math.max(bytes.length, 1), signal);
    if (existing) { verify(existing); return; }
    const markerKey = `gnc-publications/${sha256(Buffer.from(key))}.json`, marker = encode({ key, sha256: sha256(bytes), nonce: randomUUID() });
    if (await this.deps.local.create(markerKey, marker, "application/json", signal) !== "created") throw new GncError("GNC.PUBLICATION_UNKNOWN");
    const local = await this.deps.local.read(markerKey, MANIFEST_LIMIT, signal);
    if (!local || sha256(local) !== sha256(marker)) throw new GncError("GNC.LOCAL_UNVERIFIED");
    let claimed;
    try { claimed = await this.deps.remote.create(markerKey, marker, "application/json", signal); }
    catch { throw new GncError("GNC.PUBLICATION_UNKNOWN"); }
    if (claimed !== "created") throw new GncError("GNC.PUBLICATION_UNKNOWN");
    const shared = await this.deps.remote.read(markerKey, MANIFEST_LIMIT, signal);
    if (!shared || sha256(shared) !== sha256(marker)) throw new GncError("GNC.PUBLICATION_UNKNOWN");
    try { await this.deps.remote.create(key, bytes, media, signal); } catch { /* Read only after unknown PUT. */ }
    verify(await this.deps.remote.read(key, Math.max(bytes.length, 1), signal));
  }
  async inspect(raw: GncAcquireInput, signal: AbortSignal): Promise<GncAcquiredRecord | null> {
    const input = GncAcquireInputSchema.parse(raw), keys = gncKeys(input);
    const completion = await this.deps.remote.read(keys.completion, MANIFEST_LIMIT, signal); if (!completion) return null;
    const record = GncAcquiredRecordSchema.parse(decode(completion)); this.check(input, record);
    await this.intent(input, record.nonce, signal);
    const received = await this.deps.remote.read(keys.received, MANIFEST_LIMIT, signal);
    if (!received || !equal(GncReceivedRecordSchema.parse(decode(received)), this.received(record))) throw new GncError("GNC.EVIDENCE_CONFLICT");
    const source = await this.deps.remote.read(keys.source, GNC_POLICY.maxBytes, signal);
    if (!source) throw new GncError("GNC.NOT_DURABLE"); verifyBytes(record.source, source, GNC_POLICY.maxBytes);
    const result = await this.deps.remote.read(keys.evidence, JSON_LIMIT, signal);
    if (!result) throw new GncError("GNC.NOT_DURABLE"); verifyBytes(record.evidence, result, JSON_LIMIT);
    this.parsed(input, result);
    return record;
  }
  private parsed(input: GncAcquireInput, bytes: Uint8Array) {
    const result = GncParsedEvidenceSchema.parse(decode(bytes));
    if (result.kind !== input.capture.kind || result.data.url !== input.capture.url || !equal(result.network, input.network) ||
      (input.capture.kind === "product" && (result.kind !== "product" || result.data.sku !== input.capture.sku))) throw new GncError("GNC.EVIDENCE_CONFLICT");
  }
  private received(record: GncAcquiredRecord): GncReceivedRecord {
    const { evidence: _, ...base } = record;
    return GncReceivedRecordSchema.parse({ ...base, codec: "gnc-received/1" });
  }
  /** Resume only a fully retained candidate with matching shared execution intent. Never crawl or parse. */
  async resume(raw: GncAcquireInput, signal: AbortSignal): Promise<GncAcquiredRecord | null> {
    const input = GncAcquireInputSchema.parse(raw), prior = await this.inspect(input, signal); if (prior) return prior;
    const keys = gncKeys(input), saved = await this.deps.local.read(keys.completion, MANIFEST_LIMIT, signal); if (!saved) return null;
    const record = GncAcquiredRecordSchema.parse(decode(saved)); this.check(input, record); await this.intent(input, record.nonce, signal);
    const source = await this.deps.local.read(keys.source, GNC_POLICY.maxBytes, signal), result = await this.deps.local.read(keys.evidence, JSON_LIMIT, signal);
    if (!source || !result) throw new GncError("GNC.LOCAL_UNVERIFIED");
    verifyBytes(record.source, source, GNC_POLICY.maxBytes); verifyBytes(record.evidence, result, JSON_LIMIT); this.parsed(input, result);
    await this.publish(keys.source, source, "text/html", signal);
    await this.publish(keys.received, encode(this.received(record)), "application/json", signal);
    await this.publish(keys.evidence, result, "application/json", signal);
    await this.publish(keys.completion, encode(record), "application/json", signal);
    const verified = await this.inspect(input, signal); if (!verified) throw new GncError("GNC.NOT_DURABLE"); return verified;
  }
  receipt(record: GncAcquiredRecord): GncAcquireOutcome {
    return { status: "durable", operationId: record.input.capture.operationId, inputFingerprint: gncFingerprint(record.input),
      source: record.source, evidence: record.evidence, evidenceKey: gncKeys(record.input).completion };
  }
  async priorReview(input: GncAcquireInput): Promise<Extract<GncAcquireOutcome, { status: "review" }> | null> {
    const reviewId = `gnc-${gncFingerprint(input)}`;
    let saved; try { saved = await this.deps.reviews.read(reviewId); } catch { throw new GncError("GNC.REVIEW_UNVERIFIED"); }
    if (!saved) return null;
    const record = ReviewRecordSchema.parse(saved);
    if (record.reviewId !== reviewId || record.failure.operationId !== input.capture.operationId || record.failure.inputFingerprint !== gncFingerprint(input) ||
      record.failure.stage !== "gnc.capture" || record.failure.evidenceKey !== `gnc-reviews/${reviewId}.json` || !equal(record.observation, input.owner) || !equal(record.rawError.details, { input, keys: gncKeys(input) })) throw new GncError("GNC.REVIEW_UNVERIFIED");
    return { status: "review", operationId: input.capture.operationId, reviewId, evidenceKey: record.failure.evidenceKey, code: record.failure.code, automaticRetry: false };
  }
  async review(input: GncAcquireInput, error: unknown, fact: "not_executed" | "executed" | "unknown"): Promise<GncAcquireOutcome> {
    const existing = await this.priorReview(input); if (existing) return existing;
    const raw = error instanceof Error ? ("code" in error ? String(error.code) : error.message) : "";
    const code = /^(GNC|NETWORK|SOURCE|ARTIFACT)\.[A-Z_]+$/.test(raw) ? raw : "GNC.UNRESOLVED";
    const reviewId = `gnc-${gncFingerprint(input)}`, evidenceKey = `gnc-reviews/${reviewId}.json`;
    const proposed = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId, occurredAt: new Date().toISOString(),
      failure: { schemaVersion: 1, requestId: input.owner.requestId, observationId: input.owner.observationId, operationId: input.capture.operationId,
        inputFingerprint: gncFingerprint(input), stage: "gnc.capture", category: code.startsWith("NETWORK.") || code.startsWith("SOURCE.") ||
          ["GNC.ACCESS_CHALLENGE", "GNC.NOT_FOUND", "GNC.HTTP_STATUS"].includes(code) ? "SOURCE" : code.startsWith("ARTIFACT.") || /PUBLICATION|DURABLE|LOCAL_/.test(code) ? "ARTIFACT" : "PROCESSING",
        code, executionFact: fact, evidenceKey, blockedBy: null, automaticRetry: false }, observation: input.owner,
      rawError: { name: "GncCaptureFailure", message: code, stack: null, details: { input, keys: gncKeys(input) } }, candidate: null, inspection: { kind: "none" } });
    const signal = AbortSignal.timeout(10000);
    await this.deps.local.create(evidenceKey, encode(proposed), "application/json", signal);
    const retained = await this.deps.local.read(evidenceKey, MANIFEST_LIMIT, signal);
    if (!retained) throw new GncError("GNC.REVIEW_UNVERIFIED");
    const record = ReviewRecordSchema.parse(decode(retained));
    if (record.reviewId !== reviewId || !equal(record.rawError.details, proposed.rawError.details)) throw new GncError("GNC.REVIEW_UNVERIFIED");
    try { await this.deps.reviews.append(record); } catch { /* Confirm same ID; do not invent success. */ }
    let confirmed; try { confirmed = await this.deps.reviews.read(reviewId); } catch { throw new GncError("GNC.REVIEW_UNVERIFIED"); }
    if (!confirmed || !equal(ReviewRecordSchema.parse(confirmed), record)) throw new GncError("GNC.REVIEW_UNVERIFIED");
    return (await this.priorReview(input))!;
  }
}

export class AcquireGncModule {
  constructor(private readonly evidence: GncCaptureEvidence, private readonly adapter: GncAdapter) {}
  async run(raw: unknown, signal: AbortSignal): Promise<GncAcquireOutcome> {
    const input = GncAcquireInputSchema.parse(raw), e = this.evidence, keys = gncKeys(input);
    let fact: "not_executed" | "executed" | "unknown" = "not_executed";
    try {
      signal.throwIfAborted();
      const prior = await e.inspect(input, signal); if (prior) return e.receipt(prior);
      const review = await e.priorReview(input); if (review) return review;
      const resumed = await e.resume(input, signal); if (resumed) return e.receipt(resumed);
      const old = await e.deps.remote.read(keys.intent, MANIFEST_LIMIT, signal);
      if (old) { fact = "unknown"; throw new GncError("GNC.EXECUTION_UNKNOWN"); }
      const intent = GncExecutionIntentSchema.parse({ input, nonce: randomUUID() });
      let claimed;
      try { claimed = await e.deps.remote.create(keys.intent, encode(intent), "application/json", signal); }
      catch { fact = "unknown"; throw new GncError("GNC.EXECUTION_UNKNOWN"); }
      const saved = await e.deps.remote.read(keys.intent, MANIFEST_LIMIT, signal);
      if (claimed !== "created" || !saved || !equal(GncExecutionIntentSchema.parse(decode(saved)), intent)) { fact = "unknown"; throw new GncError("GNC.EXECUTION_UNKNOWN"); }
      signal.throwIfAborted(); fact = "unknown";
      let received: GncReceivedRecord | null = null;
      const result = await this.adapter.capture(input.capture, signal, async page => {
        fact = "executed";
        if (!equal(page.input, input.capture) || !equal(page.network, input.network)) throw new GncError("GNC.EVIDENCE_CONFLICT");
        const source = artifact(input, "source", page.html); verifyBytes(source, page.html, GNC_POLICY.maxBytes);
        received = GncReceivedRecordSchema.parse({ schemaVersion: 1, codec: "gnc-received/1", input, nonce: intent.nonce, receivedAt: new Date().toISOString(), source });
        const retain = AbortSignal.timeout(10000);
        await e.retain(keys.source, page.html, "text/html", retain);
        await e.retain(keys.received, encode(received), "application/json", retain);
        await e.publish(keys.source, page.html, "text/html", signal);
        await e.publish(keys.received, encode(received), "application/json", signal);
      });
      if (!received) throw new GncError("GNC.LOCAL_UNVERIFIED");
      const parsed = GncParsedEvidenceSchema.parse({ kind: input.capture.kind, data: result.data, network: result.network });
      const bytes = encode(parsed); if (bytes.length > JSON_LIMIT) throw new GncError("GNC.OUTPUT_LIMIT");
      const record = GncAcquiredRecordSchema.parse({ ...GncReceivedRecordSchema.parse(received), codec: "gnc-acquired/1", evidence: artifact(input, "evidence", bytes) });
      const retain = AbortSignal.timeout(10000);
      await e.retain(keys.evidence, bytes, "application/json", retain);
      await e.retain(keys.completion, encode(record), "application/json", retain);
      const completed = await e.resume(input, signal); if (!completed) throw new GncError("GNC.NOT_DURABLE"); return e.receipt(completed);
    } catch (error) {
      if (!signal.aborted) {
        try { const completed = await e.inspect(input, AbortSignal.timeout(10000)); if (completed) return e.receipt(completed); } catch { /* Read only. */ }
      }
      return e.review(input, signal.aborted ? new GncError("GNC.CANCELLED") : error, fact);
    }
  }
}
