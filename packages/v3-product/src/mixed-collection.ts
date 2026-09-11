import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { MixedCollectedProductSchema, MixedCollectionInputSchema, ReviewRecordSchema,
  type MixedCollectedProduct, type ProductWorkflowOutcome, type ReviewRecord } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { digest } from "@crawl-automation/v3-vision";
import type { ProductEvidenceAssembly } from "./mixed-assembly.js";
export const mixedCollectedHash = (raw: unknown) => digest(JSON.stringify(MixedCollectedProductSchema.parse(raw)));
export interface MixedCollectedRegistry { read(id: string): Promise<MixedCollectedProduct | null>; append(record: MixedCollectedProduct): Promise<void> }
export class PostgresMixedCollectedProducts implements MixedCollectedRegistry {
  constructor(private readonly db: { query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }) {}
  async read(id: string) {
    const row = (await this.db.query("SELECT record,record_hash,observation_id FROM public.collected_product WHERE operation_id=$1", [id])).rows[0];
    if (!row) return null;
    const parsed = MixedCollectedProductSchema.safeParse(row.record);
    if (!parsed.success) throw Error("MIXED_COLLECTION.RESULT_CONFLICT");
    const r = parsed.data;
    if (r.operationId !== id || r.observation.observationId !== row.observation_id || mixedCollectedHash(r) !== row.record_hash)
      throw Error("MIXED_COLLECTION.RESULT_INTEGRITY");
    return r;
  }
  async append(raw: MixedCollectedProduct) {
    const r = MixedCollectedProductSchema.parse(raw);
    await this.db.query("INSERT INTO public.collected_product(operation_id,observation_id,record_hash,record) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING",
      [r.operationId, r.observation.observationId, mixedCollectedHash(r), JSON.stringify(r)]);
    const saved = await this.read(r.operationId);
    if (!saved || mixedCollectedHash(saved) !== mixedCollectedHash(r)) throw Error("MIXED_COLLECTION.RESULT_CONFLICT");
  }
}
/** Independent persistence only: no model calls, assembly publication, company matching or legacy writes. */
export class CollectMixedProduct {
  constructor(private readonly deps: { assembly: Pick<ProductEvidenceAssembly, "inspectReady">; registry: MixedCollectedRegistry;
    local: ObjectStore; remote: ObjectStore; reviews: { append(r: ReviewRecord): Promise<unknown>; read(id: string): Promise<ReviewRecord | null> } }) {}
  async run(raw: unknown, signal: AbortSignal): Promise<ProductWorkflowOutcome> {
    const input = MixedCollectionInputSchema.parse(raw), manifest = input.join.manifest;
    let candidate: MixedCollectedProduct | null = null;
    try {
      const evidence = await this.deps.assembly.inspectReady(input.join, input.evidenceKey, signal), result = evidence.output.result;
      candidate = MixedCollectedProductSchema.parse({ schemaVersion: 2, codec: "collected-product/2", operationId: manifest.operationId,
        observation: manifest.observation, assembly: { objectKey: evidence.key, sha256: digest(evidence.bytes), byteSize: evidence.bytes.length },
        formula: result.formula, ingredients: result.ingredients, warnings: result.warnings, provenance: result.provenance });
      const hash = mixedCollectedHash(candidate), prior = await this.deps.registry.read(candidate.operationId);
      if (prior && mixedCollectedHash(prior) !== hash) throw Error("MIXED_COLLECTION.RESULT_CONFLICT");
      if (!prior) {
        const key = `mixed-collection-journal/${candidate.operationId}.json`, bytes = Buffer.from(JSON.stringify(candidate));
        if (bytes.length > 8 * 1024 * 1024) throw Error("MIXED_COLLECTION.OUTPUT_LIMIT");
        if (await this.deps.local.read(key, 8 * 1024 * 1024, signal)) throw Error("MIXED_COLLECTION.HANDOFF_PENDING");
        await this.deps.local.create(key, bytes, "application/json", signal);
        const saved = await this.deps.local.read(key, 8 * 1024 * 1024, signal);
        if (!saved || digest(saved) !== digest(bytes)) throw Error("MIXED_COLLECTION.LOCAL_UNVERIFIED");
        // Shared intent also protects a replacement host with an empty local cache.
        const intentKey = `mixed-collection-intents/${candidate.operationId}.json`, marker = Buffer.from(JSON.stringify({ hash, nonce: randomUUID() }));
        let claimed;
        try { claimed = await this.deps.remote.create(intentKey, marker, "application/json", signal); }
        catch { throw Error("MIXED_COLLECTION.HANDOFF_PENDING"); }
        if (claimed !== "created") throw Error("MIXED_COLLECTION.HANDOFF_PENDING");
        const intent = await this.deps.remote.read(intentKey, 65536, signal);
        if (!intent || digest(intent) !== digest(marker)) throw Error("MIXED_COLLECTION.HANDOFF_PENDING");
        try { await this.deps.registry.append(candidate); }
        catch (error) { if (error instanceof Error && error.message === "MIXED_COLLECTION.RESULT_CONFLICT") throw error; /* Read back only. */ }
      }
      const saved = await this.deps.registry.read(candidate.operationId);
      if (!saved || mixedCollectedHash(saved) !== hash) throw Error("MIXED_COLLECTION.REGISTRATION_UNKNOWN");
      await this.deps.assembly.inspectReady(input.join, input.evidenceKey, signal);
      return { status: "collected", operationId: saved.operationId, observationId: saved.observation.observationId,
        recordHash: hash, evidenceKey: input.evidenceKey };
    } catch (error) {
      const message = error instanceof Error ? error.message : "", code = /^(MIXED_COLLECTION|MIXED|SAVED)\.[A-Z_]+$/.test(message) ? message : "MIXED_COLLECTION.UNRESOLVED";
      const r = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: `mixed-collect-${randomUUID()}`, occurredAt: new Date().toISOString(),
        observation: manifest.observation, failure: { schemaVersion: 1, requestId: manifest.observation.requestId, observationId: manifest.observation.observationId,
          operationId: manifest.operationId, inputFingerprint: digest(JSON.stringify(input)), stage: "product.evidence.collect", category: "INGEST", code,
          executionFact: "unknown", evidenceKey: input.evidenceKey, blockedBy: null, automaticRetry: false },
        rawError: { name: "MixedCollectionError", message: code, stack: null, details: { input } },
        candidate: candidate ? { schema: "collected-product/2", value: candidate } : null, inspection: { kind: "none" } });
      const key = `mixed-collection-reviews/${r.reviewId}.json`, bytes = Buffer.from(JSON.stringify(r)), retention = AbortSignal.timeout(10000);
      await this.deps.local.create(key, bytes, "application/json", retention);
      const local = await this.deps.local.read(key, 8 * 1024 * 1024, retention);
      if (!local || digest(local) !== digest(bytes)) throw Error("MIXED_COLLECTION.REVIEW_UNVERIFIED");
      try { await this.deps.reviews.append(r); } catch { /* Same-ID readback. */ }
      const confirmed = await this.deps.reviews.read(r.reviewId);
      if (!confirmed || !equal(ReviewRecordSchema.parse(confirmed), r)) throw Error("MIXED_COLLECTION.REVIEW_UNVERIFIED");
      return { status: "review", reviewId: r.reviewId, evidenceKey: input.evidenceKey, codes: [code], automaticRetry: false };
    }
  }
}
