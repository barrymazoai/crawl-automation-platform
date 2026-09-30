import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import type { Pool } from "pg";
import { AmazonLinkBatchSchema, type AmazonLinkBatch } from "./amazon-link-batches.js";

/** Immutable database authorization, with bounded positive caching and legacy fallback.
 * A missing row may use a legacy batch; a database error must never grant fallback access.
 * Misses are not cached: new batches become visible without restarting any worker.
 */
export class AmazonLinkStore {
  private readonly cache = new Map<string, AmazonLinkBatch>();
  private readonly legacy: Map<string, AmazonLinkBatch>;
  constructor(private readonly db: Pick<Pool, "query">, legacy: readonly AmazonLinkBatch[] = [], private readonly limit = 256) {
    this.legacy = new Map(legacy.map(raw => { const b = AmazonLinkBatchSchema.parse(raw); return [b.requestId, b]; }));
    if (!Number.isInteger(limit) || limit < 1) throw Error("AMAZON.LINK_CACHE_LIMIT");
  }
  async get(requestId: string): Promise<AmazonLinkBatch | null> {
    requestId = z.uuid().parse(requestId);
    const cached = this.cache.get(requestId);
    if (cached) { this.cache.delete(requestId); this.cache.set(requestId, cached); return structuredClone(cached); }
    const row = (await this.db.query("SELECT record FROM amazon_link_batch WHERE request_id=$1", [requestId])).rows[0];
    const old = this.legacy.get(requestId);
    if (!row) return old ? structuredClone(old) : null;
    const batch = AmazonLinkBatchSchema.parse(row.record);
    if (batch.requestId !== requestId || old && !equal(old, batch)) throw Error("AMAZON.LINK_IDENTITY_CONFLICT");
    this.cache.set(requestId, batch);
    if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value!);
    return structuredClone(batch);
  }
  async put(raw: unknown): Promise<AmazonLinkBatch> {
    const batch = AmazonLinkBatchSchema.parse(raw);
    await this.db.query("INSERT INTO amazon_link_batch(request_id,record) VALUES($1,$2) ON CONFLICT DO NOTHING", [batch.requestId, batch]);
    // Do not use the cache to verify a write or a conflicting legacy definition.
    const row = (await this.db.query("SELECT record FROM amazon_link_batch WHERE request_id=$1", [batch.requestId])).rows[0];
    if (!row || !equal(AmazonLinkBatchSchema.parse(row.record), batch)) throw Error("AMAZON.LINK_IDENTITY_CONFLICT");
    return batch;
  }
}
