import type {
  NotSupplementDelivered,
  NotSupplementFilter,
  ProductSyncLedger,
  SyncChange,
  SyncKey,
  SyncRecord,
  SyncStatus,
  SyncOverview,
  MarketplaceChannel,
  RefreshedEnrichment,
  ReopenFilter,
  ReopenResult,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { PENDING_SYNC, settledMarketplace } from "../product-sync/marketplace-queries.js";
import { refreshedEnrichments } from "./product-sync-enrichments.js";
import { reopenAmazonListingDates } from "./product-sync-listing-dates.js";
import { reopenSync } from "./product-sync-reopen.js";
import { markRemoved, notSupplementsDelivered } from "./product-sync-removals.js";

interface Row {
  channel: MarketplaceChannel;
  listing_id: string;
  variant_key: string;
  status: SyncStatus;
  collected_operation_id: string | null;
  payload_hash: string | null;
  ingest_run_id: string | null;
  supply_smart_product_id: string | null;
  supply_smart_listing_id: string | null;
  error: Record<string, unknown> | null;
  attempts: number;
  updated_at: Date;
  material_at: Date | null;
}

const keyArrays = (keys: SyncKey[]) => [
  keys.map((key) => key.channel),
  keys.map((key) => key.listingId),
  keys.map((key) => key.variantId ?? ""),
];

function toRecord(row: Row): SyncRecord {
  return {
    channel: row.channel,
    listingId: row.listing_id,
    variantId: row.variant_key === "" ? null : row.variant_key,
    status: row.status,
    collectedOperationId: row.collected_operation_id,
    payloadHash: row.payload_hash,
    ingestRunId: row.ingest_run_id,
    supplySmartProductId: row.supply_smart_product_id,
    supplySmartListingId: row.supply_smart_listing_id,
    error: row.error,
    attempts: row.attempts,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Migration 061. SQL for the marketplace sync ledger lives only here. */
export class PostgresProductSync implements ProductSyncLedger {
  constructor(private readonly database: Queryable) {}

  async read(keys: SyncKey[]): Promise<SyncRecord[]> {
    if (!keys.length) {
      return [];
    }
    const rows = await this.database.query<Row>(
      `SELECT ps.* FROM product_sync ps
       JOIN unnest($1::text[], $2::text[], $3::text[]) AS k(channel, listing_id, variant_key)
         ON ps.channel = k.channel AND ps.listing_id = k.listing_id AND ps.variant_key = k.variant_key`,
      keyArrays(keys),
    );
    return rows.map(toRecord);
  }

  async record(changes: SyncChange[]): Promise<void> {
    for (const change of changes) {
      await this.database.query(
        `INSERT INTO product_sync AS ps (channel, listing_id, variant_key, status, collected_operation_id,
           payload_hash, ingest_run_id, supply_smart_product_id, supply_smart_listing_id, error, material_at, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz,
           CASE WHEN $4 = 'sent' THEN 1 ELSE 0 END)
         ON CONFLICT (channel, listing_id, variant_key) DO UPDATE SET
           status = EXCLUDED.status,
           collected_operation_id = COALESCE(EXCLUDED.collected_operation_id, ps.collected_operation_id),
           payload_hash = COALESCE(EXCLUDED.payload_hash, ps.payload_hash),
           ingest_run_id = COALESCE(EXCLUDED.ingest_run_id, ps.ingest_run_id),
           supply_smart_product_id = COALESCE(EXCLUDED.supply_smart_product_id, ps.supply_smart_product_id),
           supply_smart_listing_id = COALESCE(EXCLUDED.supply_smart_listing_id, ps.supply_smart_listing_id),
           error = EXCLUDED.error,
           material_at = COALESCE(EXCLUDED.material_at, ps.material_at),
           attempts = ps.attempts + CASE WHEN EXCLUDED.status = 'sent' THEN 1 ELSE 0 END,
           updated_at = clock_timestamp()`,
        [
          change.channel,
          change.listingId,
          change.variantId ?? "",
          change.status,
          change.collectedOperationId ?? null,
          change.payloadHash ?? null,
          change.ingestRunId ?? null,
          change.supplySmartProductId ?? null,
          change.supplySmartListingId ?? null,
          change.error ? JSON.stringify(change.error) : null,
          change.materialAt ?? null,
        ],
      );
    }
  }

  async touch(entries: (SyncKey & { materialAt: string })[]): Promise<void> {
    if (!entries.length) {
      return;
    }
    await this.database.query(
      `UPDATE product_sync ps SET material_at = key.material_at, updated_at = clock_timestamp()
       FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[])
         AS key(channel, listing_id, variant_key, material_at)
       WHERE ps.channel = key.channel AND ps.listing_id = key.listing_id AND ps.variant_key = key.variant_key`,
      [...keyArrays(entries), entries.map((entry) => entry.materialAt)],
    );
  }

  async markPresent(keys: SyncKey[]): Promise<{ marked: number; skipped: number }> {
    if (!keys.length) {
      return { marked: 0, skipped: 0 };
    }
    const rows = await this.database.query<{ marked: number }>(
      `WITH k AS (SELECT DISTINCT * FROM unnest($1::text[], $2::text[], $3::text[]) AS k(channel, listing_id, variant_key)),
       ins AS (
         INSERT INTO product_sync (channel, listing_id, variant_key, status, material_at)
         SELECT channel, listing_id, variant_key, 'present', clock_timestamp() FROM k
         ON CONFLICT (channel, listing_id, variant_key) DO UPDATE SET status = 'present',
           material_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE product_sync.attempts = 0 AND product_sync.status IN ('present', 'waiting_company')
         RETURNING 1)
       SELECT count(*)::int AS marked FROM ins`,
      keyArrays(keys),
    );
    const marked = rows[0]?.marked ?? 0;
    return {
      marked,
      skipped:
        new Set(
          keys.map((key) => `${key.channel}\u0000${key.listingId}\u0000${key.variantId ?? ""}`),
        ).size - marked,
    };
  }

  reopen(filter: ReopenFilter): Promise<ReopenResult> {
    return "listingDates" in filter
      ? reopenAmazonListingDates(this.database, filter)
      : reopenSync(this.database, filter);
  }

  markRemoved(key: SyncKey): Promise<void> {
    return markRemoved(this.database, key);
  }

  notSupplementsDelivered(filter: NotSupplementFilter): Promise<NotSupplementDelivered[]> {
    return notSupplementsDelivered(this.database, filter);
  }

  refreshedEnrichments(filter: { after?: string; limit: number }): Promise<RefreshedEnrichment[]> {
    return refreshedEnrichments(this.database, filter);
  }

  async counts(): Promise<{ channel: MarketplaceChannel; status: SyncStatus; count: number }[]> {
    return this.database.query(
      `SELECT channel, status, count(*)::int AS count FROM product_sync GROUP BY 1, 2 ORDER BY 1, 2`,
    );
  }

  /** Same selection as the marketplace reader (latest settled completed queue item), counted without reading R2. */
  async overview(): Promise<SyncOverview[]> {
    return this.database.query<SyncOverview>(
      `WITH ${settledMarketplace("q.channel IN ('amazon', 'gnc', 'swanson', 'wholefoods', 'costco')")}
       SELECT d.channel, count(*)::int AS completed,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM supply_smart_brand_company m
           WHERE m.brand_id = d.brand_id AND m.status = 'matched'))::int AS "matchedBrand",
         count(*) FILTER (WHERE ${PENDING_SYNC})::int AS pending
       FROM done d GROUP BY d.channel ORDER BY d.channel`,
    );
  }
}
