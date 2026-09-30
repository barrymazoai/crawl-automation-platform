import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { GncDiscoveryInputSchema, GncDiscoveryRecordSchema, GncDiscoveryOutcomeSchema, GncParsedEvidenceSchema, ReviewRecordSchema,
  type GncDiscoveryInput, type GncDiscoveryRecord, type GncDiscoveryOutcome } from "@crawl-automation/v3-contracts";
import { sha256, verifyBytes } from "@crawl-automation/v3-artifacts";
import { GncCaptureEvidence } from "./gnc-handoff.js";
const encode = (x: unknown) => Buffer.from(JSON.stringify(x));
const LIMIT = 8 * 1024 * 1024;
export const gncDiscoveryId = (raw: GncDiscoveryInput) => `gncd-${sha256(encode(GncDiscoveryInputSchema.parse(raw)))}`;
export const gncDiscoveryKey = (raw: GncDiscoveryInput) => `v3/gnc-discoveries/${gncDiscoveryId(raw)}/discovery.json`;
/** One already-captured catalog entry per operation. No browser, provider or product processing. */
export class GncCatalogDiscoveries {
  constructor(private readonly evidence: GncCaptureEvidence) {}
  private async derive(input: GncDiscoveryInput, signal: AbortSignal) {
    const capture = await this.evidence.inspect(input.task, signal);
    if (!capture) throw Error("GNC.DISCOVERY_SOURCE_UNVERIFIED");
    const bytes = await this.evidence.deps.remote.read(capture.evidence.objectKey, LIMIT, signal);
    if (!bytes) throw Error("GNC.DISCOVERY_SOURCE_UNVERIFIED");
    verifyBytes(capture.evidence, bytes, LIMIT);
    const parsed = GncParsedEvidenceSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (parsed.kind !== "catalog-page" || parsed.data.url !== input.task.capture.url || !equal(parsed.network, input.task.network)) throw Error("GNC.DISCOVERY_IDENTITY_CONFLICT");
    const entry = parsed.data.entries[input.index];
    if (!entry) throw Error("GNC.DISCOVERY_INDEX_INVALID");
    return GncDiscoveryRecordSchema.parse({ codec: "gnc-discovery/1", discoveryId: gncDiscoveryId(input), input, capture, entry,
      total: parsed.data.entries.length, nextUrl: parsed.data.nextUrl, completion: parsed.data.completion });
  }
  async inspect(raw: unknown, signal: AbortSignal): Promise<GncDiscoveryRecord | null> {
    const input = GncDiscoveryInputSchema.parse(raw), key = gncDiscoveryKey(input);
    const prior = await this.evidence.deps.remote.read(key, LIMIT, signal);
    if (!prior) return null;
    const record = await this.derive(input, signal);
    if (sha256(prior) !== sha256(encode(record))) throw Error("GNC.DISCOVERY_CONFLICT");
    return record;
  }
  async run(raw: unknown, signal: AbortSignal): Promise<GncDiscoveryOutcome> {
    const input = GncDiscoveryInputSchema.parse(raw), id = gncDiscoveryId(input), key = gncDiscoveryKey(input), deps = this.evidence.deps;
    let candidate: GncDiscoveryRecord | null = null;
    try {
      signal.throwIfAborted(); candidate = await this.derive(input, signal);
      const bytes = encode(candidate);
      const verify = (saved: Uint8Array | null) => { if (!saved || sha256(saved) !== sha256(bytes)) throw Error("GNC.DISCOVERY_UNVERIFIED"); };
      const prior = await deps.remote.read(key, LIMIT, signal);
      if (prior) verify(prior);
      else {
        const intentKey = `v3/gnc-discoveries/${id}/intent.json`;
        if (await deps.remote.read(intentKey, 65536, signal)) throw Error("GNC.DISCOVERY_HANDOFF_PENDING");
        // A stopped/unknown publisher is never implicitly resumed by a replacement worker.
        if (await deps.local.read(key, LIMIT, signal)) throw Error("GNC.DISCOVERY_HANDOFF_PENDING");
        await deps.local.create(key, bytes, "application/json", signal); verify(await deps.local.read(key, LIMIT, signal));
        const marker = encode({ sha256: sha256(bytes), nonce: randomUUID() });
        if (await deps.remote.create(intentKey, marker, "application/json", signal) !== "created") throw Error("GNC.DISCOVERY_HANDOFF_PENDING");
        const claimed = await deps.remote.read(intentKey, 65536, signal);
        if (!claimed || sha256(claimed) !== sha256(marker)) throw Error("GNC.DISCOVERY_HANDOFF_PENDING");
        try { await deps.remote.create(key, bytes, "application/json", signal); } catch { /* Read back once; never retry PUT. */ }
        verify(await deps.remote.read(key, LIMIT, signal));
      }
      return GncDiscoveryOutcomeSchema.parse({ status: "published", discoveryId: id, input, index: input.index, total: candidate.total,
        evidenceKey: key, sha256: sha256(bytes), entry: candidate.entry, nextUrl: candidate.nextUrl, completion: candidate.completion });
    } catch (error) {
      signal.throwIfAborted();
      const msg = error instanceof Error ? error.message : "";
      const code = /^(GNC|ARTIFACT)\.[A-Z_]+$/.test(msg) ? msg : "GNC.DISCOVERY_UNRESOLVED";
      const review = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: `gncd-review-${randomUUID()}`, occurredAt: new Date().toISOString(), observation: input.task.owner,
        failure: { schemaVersion: 1, requestId: input.task.owner.requestId, observationId: input.task.owner.observationId, operationId: id,
          inputFingerprint: sha256(encode(input)), stage: "gnc.discovery", category: "SOURCE", code, executionFact: "unknown", evidenceKey: key,
          blockedBy: null, automaticRetry: false }, rawError: { name: "GncDiscoveryError", message: code, stack: null, details: { input } },
        candidate: candidate ? { schema: "gnc-discovery/1", value: candidate } : null, inspection: { kind: "none" } });
      const reviewKey = `v3/gnc-discoveries/${id}/${review.reviewId}.json`, b = encode(review), retention = AbortSignal.timeout(10000);
      await deps.local.create(reviewKey, b, "application/json", retention);
      const saved = await deps.local.read(reviewKey, LIMIT, retention);
      if (!saved || sha256(saved) !== sha256(b)) throw Error("GNC.REVIEW_UNVERIFIED");
      try { await deps.reviews.append(review); } catch { /* same-ID readback */ }
      if (!equal(await deps.reviews.read(review.reviewId), review)) throw Error("GNC.REVIEW_UNVERIFIED");
      return GncDiscoveryOutcomeSchema.parse({ status: "review", discoveryId: id, input, index: input.index, total: candidate?.total ?? null,
        reviewId: review.reviewId, evidenceKey: key, code, automaticRetry: false });
    }
  }
}
