import {
  ScanAdmissionCountsSchema,
  type AddToQueue,
  type ScanAdmissionSettings,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

/** SQL admission only; the application explicitly opts a discovery batch into this policy. */
/**
 * KAN-253: a brand family's own-site catalogs (settings ownerBrand, set only by brand enrichment). The family's own
 * whole-store catalog leaves a product to the sub-brand catalog on the same site that already holds it (same listing
 * and variant, any state but withdrawn), so each product is captured once, under its sub-brand. Counted as recent.
 */
const FAMILY_HELD = `($1 = 'dtc' AND EXISTS (
  SELECT 1 FROM dtc_source_settings mine
  JOIN brand_source mine_source ON mine_source.id = mine.source_id
  JOIN brand mine_brand ON mine_brand.id = mine_source.brand_id
  JOIN dtc_source_settings other ON other.settings->>'siteKey' = mine.settings->>'siteKey'
    AND other.source_id <> mine.source_id AND other.settings->'brands'->0->>'ownerBrand' IS NOT NULL
  JOIN queue_item held ON held.channel = 'dtc' AND held.source_id = other.source_id
    AND held.listing_id = r.listing_id AND coalesce(held.variant_id, '') = coalesce(r.variant_id, '')
    AND held.state <> 'withdrawn'
  WHERE mine.source_id = r.source_id
    AND regexp_replace(lower(mine_brand.name), '[^[:alnum:]]+', '', 'g')
      = regexp_replace(lower(mine.settings->'brands'->0->>'ownerBrand'), '[^[:alnum:]]+', '', 'g')))`;

export class PostgresScanAdmission {
  constructor(private readonly tx: Queryable) {}

  async insert(request: { input: AddToQueue; rows: string; settings: ScanAdmissionSettings }) {
    const { input, rows, settings } = request;
    const result = await this.tx.query(
      `WITH candidates AS MATERIALIZED (
         SELECT r.*, $4::int > 0 AND NOT EXISTS (
           SELECT 1 FROM queue_item i WHERE i.channel = $1 AND i.listing_id = r.listing_id
             AND ($1 <> 'dtc' OR i.source_id = r.source_id)
             AND coalesce(i.variant_id, '') = coalesce(r.variant_id, '')
             AND i.state IN ('queued', 'ready', 'running', 'following')) AND EXISTS (
           SELECT 1 FROM queue_item i WHERE i.channel = $1 AND i.listing_id = r.listing_id
             AND ($1 <> 'dtc' OR i.source_id = r.source_id)
             AND coalesce(i.variant_id, '') = coalesce(r.variant_id, '')
             AND i.state IN ('completed', 'review')
             AND i.updated_at >= statement_timestamp() - make_interval(hours => $4::int)) AS recent,
           ${FAMILY_HELD} AS family_held
         FROM jsonb_to_recordset($3::jsonb)
           AS r(item_id text, source_id uuid, url text, listing_id text, variant_id text)
       ), inserted AS (
         INSERT INTO queue_item (item_id, channel, batch_id, source_id, url, listing_id, variant_id)
         SELECT item_id, $1, $2, source_id, url, listing_id, variant_id FROM candidates
         WHERE NOT recent AND NOT family_held
         ON CONFLICT DO NOTHING RETURNING item_id, state
       )
       INSERT INTO queue_scan_admission (batch_id, recent_skip_hours, added, following, recent)
       SELECT $2, $4, (SELECT count(*) FROM inserted WHERE state = 'queued'),
         (SELECT count(*) FROM inserted WHERE state = 'following'),
         (SELECT count(*) FROM candidates WHERE recent OR family_held)
       RETURNING added, following, recent`,
      [input.channel, input.batchId, rows, settings.recentScanSkipHours],
    );
    return ScanAdmissionCountsSchema.parse(result[0]);
  }

  /** A crash after enqueueing must not replace the scan's original counts with zeroes. */
  async replay(batchId: string) {
    const saved = await this.tx.query(
      "SELECT added, following, recent FROM queue_scan_admission WHERE batch_id = $1",
      [batchId],
    );
    if (saved[0]) {
      return ScanAdmissionCountsSchema.parse(saved[0]);
    }
    // Historical batches predate receipts and never skipped recent SKUs. No new admission on replay.
    const legacy = await this.tx.query(
      `SELECT count(*) FILTER (WHERE follows_item_id IS NULL)::int AS added,
         count(*) FILTER (WHERE follows_item_id IS NOT NULL)::int AS following, 0 AS recent
       FROM queue_item WHERE batch_id = $1`,
      [batchId],
    );
    return ScanAdmissionCountsSchema.parse(legacy[0]);
  }
}
