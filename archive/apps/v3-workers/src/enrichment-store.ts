import type pg from "pg";
import { EnrichmentRecordSchema, ExistingFormulaInputSchema, RecentAttemptInputSchema, RecentAttemptSchema, ExistingFormulaSchema, LabelCollectedProductSchema, type EnrichmentRecord, type ExistingFormula } from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/v3-artifacts";

type Db = Pick<pg.Pool, "query">;
/** Ledger adapters for product enrichment (Mini only; the table is append-only). */
export function enrichmentStores(db: Db) {
  return {
    collections: { async read(operationId: string) { return (await db.query("SELECT record FROM collected_product WHERE operation_id=$1", [operationId])).rows[0]?.record ?? null; } },
    captures: { async describe(observationId: string) {
      const row = (await db.query("SELECT record FROM product_history_source WHERE dataset LIKE 'v3:%' AND record->>'codec'='v3-capture-history/1' AND record->>'observationId'=$1 ORDER BY imported_at DESC LIMIT 1", [observationId])).rows[0];
      if (!row) return null;
      const r = row.record as { listing?: { url?: string }; capture?: { title?: unknown; projection?: { title?: unknown } } };
      const title = typeof r.capture?.title === "string" ? r.capture.title : typeof r.capture?.projection?.title === "string" ? r.capture.projection.title : null;
      return { title, url: typeof r.listing?.url === "string" ? r.listing.url : null };
    } },
    registry: {
      async read(enrichmentId: string) { return (await db.query("SELECT record FROM product_enrichment WHERE enrichment_id=$1", [enrichmentId])).rows[0]?.record ?? null; },
      async register(record: EnrichmentRecord) {
        const r = EnrichmentRecordSchema.parse(record), hash = sha256(Buffer.from(JSON.stringify(r)));
        await db.query(`INSERT INTO product_enrichment(enrichment_id,listing_id,formula_hash,protocol,collection_operation_id,record_hash,record) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (enrichment_id) DO NOTHING`,
          [r.enrichmentId, r.listingId, r.formulaHash, r.protocol, r.collectionOperationId, hash, JSON.stringify(r)]);
      },
    },
  };
}
/** Latest current-structure formula already collected for this listing, or none. Read-only. */
export async function inspectRecentAttempt(db: Db, raw: unknown) {
  const { listingId, withinHours } = RecentAttemptInputSchema.parse(raw);
  // Only a collected result counts as done: a listing that ended in a Review (transport or content) may be retried.
  const row = (await db.query(`SELECT collected_at AS at, 'collected' AS kind FROM collected_product WHERE record->'observation'->>'listingId'=$1
    AND collected_at > now() - ($2 || ' hours')::interval ORDER BY collected_at DESC LIMIT 1`, [listingId, String(withinHours)])).rows[0];
  return RecentAttemptSchema.parse({ schemaVersion: 1, attemptedAt: row ? new Date(row.at).toISOString() : null, kind: row?.kind ?? null });
}
export async function inspectExistingFormula(db: Db, raw: unknown): Promise<ExistingFormula> {
  const { owner } = ExistingFormulaInputSchema.parse(raw);
  const row = (await db.query("SELECT operation_id,record,record_hash,collected_at FROM collected_product WHERE record->'observation'->>'listingId'=$1 AND record->>'codec' IN ('collected-product/3','collected-product/4') ORDER BY collected_at DESC LIMIT 1", [owner.listingId])).rows[0];
  if (!row) return ExistingFormulaSchema.parse({ exists: false });
  const record = LabelCollectedProductSchema.parse(row.record);
  if (record.operationId !== row.operation_id || record.observation.listingId !== owner.listingId) throw Error("ENRICH.EXISTING_FORMULA_INTEGRITY");
  return ExistingFormulaSchema.parse({ exists: true, operationId: record.operationId, observationId: record.observation.observationId, codec: record.codec,
    evidenceKey: record.assembly.objectKey, recordHash: row.record_hash, collectedAt: new Date(row.collected_at).toISOString() });
}
