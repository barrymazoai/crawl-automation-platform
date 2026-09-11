import { randomUUID } from "node:crypto";
import { CollectedProductSchema, ProductCollectionInputSchema, ReviewRecordSchema,
  type CollectedProduct, type ProductWorkflowOutcome, type ReviewRecord } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { digest } from "@crawl-automation/v3-vision";
import type { ProductImageAssembly } from "./assembly.js";
type Query = { query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
export const collectedHash = (r: unknown) => digest(JSON.stringify(CollectedProductSchema.parse(r)));
export interface CollectedRegistry { read(operationId: string): Promise<CollectedProduct | null>; append(record: CollectedProduct): Promise<void> }
export class PostgresCollectedProducts implements CollectedRegistry {
  constructor(private readonly db: Query) {}
  async read(id: string) {
    const row = (await this.db.query("SELECT record,record_hash,observation_id FROM public.collected_product WHERE operation_id=$1", [id])).rows[0];
    if (!row) return null;
    const record = CollectedProductSchema.parse(row.record);
    if (record.operationId !== id || record.observation.observationId !== row.observation_id || collectedHash(record) !== row.record_hash)
      throw Error("COLLECTION.RESULT_INTEGRITY");
    return record;
  }
  async append(raw: CollectedProduct) {
    const r = CollectedProductSchema.parse(raw);
    await this.db.query("INSERT INTO public.collected_product(operation_id,observation_id,record_hash,record) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING",
      [r.operationId, r.observation.observationId, collectedHash(r), JSON.stringify(r)]);
    const saved = await this.read(r.operationId);
    if (!saved || collectedHash(saved) !== collectedHash(r)) throw Error("COLLECTION.RESULT_CONFLICT");
  }
}
/** A separate Activity: no assembly publication, model, OCR, company lookup or formal product service writes. */
export class CollectProduct {
  constructor(private readonly deps: { assembly: Pick<ProductImageAssembly, "inspectReady">; registry: CollectedRegistry;
    local: ObjectStore; reviews: { append(record: ReviewRecord): Promise<{ reviewId: string }> } }) {}
  async run(raw: unknown, signal: AbortSignal): Promise<ProductWorkflowOutcome> {
    const input = ProductCollectionInputSchema.parse(raw), manifest = input.join.manifest;
    let candidate: CollectedProduct | null = null;
    try {
      const evidence = await this.deps.assembly.inspectReady(input.join, input.evidenceKey, signal);
      candidate = CollectedProductSchema.parse({ schemaVersion: 1, codec: "collected-product/1", operationId: manifest.operationId,
        observation: manifest.observation, assembly: { objectKey: evidence.key, sha256: digest(evidence.bytes), byteSize: evidence.bytes.length },
        formula: evidence.output.result.formula, ingredients: evidence.output.result.ingredients, provenance: evidence.output.result.provenance });
      const existing = await this.deps.registry.read(candidate.operationId);
      if (existing && collectedHash(existing) !== collectedHash(candidate)) throw Error("COLLECTION.RESULT_CONFLICT");
      if (!existing) {
        // Keep snapshot before an uncertain DB commit. No automatic second INSERT.
        const key = `collection-journal/${candidate.operationId}.json`, bytes = Buffer.from(JSON.stringify(candidate));
        const prior = await this.deps.local.read(key, 8 * 1024 * 1024, signal);
        if (prior) throw Error("COLLECTION.HANDOFF_PENDING");
        await this.deps.local.create(key, bytes, "application/json", signal);
        const local = await this.deps.local.read(key, 8 * 1024 * 1024, signal);
        if (!local || digest(local) !== digest(bytes)) throw Error("COLLECTION.LOCAL_UNVERIFIED");
        try { await this.deps.registry.append(candidate); } catch (error) {
          if (error instanceof Error && error.message === "COLLECTION.RESULT_CONFLICT") throw error;
          // Read-only verification of a possibly committed INSERT; never issue a second INSERT here.
        }
      }
      const saved = await this.deps.registry.read(candidate.operationId);
      if (!saved || collectedHash(saved) !== collectedHash(candidate)) throw Error("COLLECTION.REGISTRATION_UNKNOWN");
      await this.deps.assembly.inspectReady(input.join, input.evidenceKey, signal);
      return { status: "collected", operationId: saved.operationId, observationId: saved.observation.observationId,
        evidenceKey: input.evidenceKey, recordHash: collectedHash(saved) };
    } catch (error) {
      const allowed = ["COLLECTION.NOT_READY", "COLLECTION.EVIDENCE_UNVERIFIED", "COLLECTION.RESULT_CONFLICT", "COLLECTION.RESULT_INTEGRITY",
        "COLLECTION.HANDOFF_PENDING", "COLLECTION.LOCAL_UNVERIFIED", "COLLECTION.REGISTRATION_UNKNOWN"];
      const code = error instanceof Error && allowed.includes(error.message) ? error.message : "COLLECTION.UNRESOLVED";
      const review = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: `collection-${randomUUID()}`, occurredAt: new Date().toISOString(),
        failure: { schemaVersion: 1, requestId: manifest.observation.requestId, observationId: manifest.observation.observationId,
          operationId: manifest.operationId, inputFingerprint: digest(JSON.stringify(input)), stage: "product.collect", category: "INGEST",
          code, executionFact: "unknown", evidenceKey: input.evidenceKey, blockedBy: null, automaticRetry: false }, observation: manifest.observation,
        rawError: { name: "CollectionError", message: code, stack: null, details: { input } },
        candidate: candidate ? { schema: "collected-product/1", value: candidate } : null, inspection: { kind: "none" } });
      const key = `collection-reviews/${review.reviewId}.json`, bytes = Buffer.from(JSON.stringify(review)), retention = AbortSignal.timeout(10000);
      await this.deps.local.create(key, bytes, "application/json", retention);
      const saved = await this.deps.local.read(key, 8 * 1024 * 1024, retention);
      if (!saved || digest(saved) !== digest(bytes)) throw Error("COLLECTION.REVIEW_UNVERIFIED");
      const receipt = await this.deps.reviews.append(review);
      return { status: "review", evidenceKey: input.evidenceKey, reviewId: receipt.reviewId, codes: [code], automaticRetry: false };
    }
  }
}
