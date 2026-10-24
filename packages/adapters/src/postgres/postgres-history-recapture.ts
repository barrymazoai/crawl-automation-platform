import type {
  HistoryRecaptureStore,
  RecaptureCandidate,
  RecaptureSource,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";

const CandidateRow = z.strictObject({
  listingId: z.string().regex(/^[A-Z0-9]{10}$/u),
  observedAt: z.coerce.date().transform((date) => date.toISOString()),
  pageBrand: z.string().nullable(),
  ownerBrandId: z.string().nullable(),
  queuedSourceId: z.uuid().nullable(),
});
const SourceRow = z.strictObject({
  sourceId: z.uuid(),
  brandId: z.uuid(),
  brandName: z.string(),
  url: z.string(),
});

/**
 * Amazon listings whose latest V3 capture is older than the cutoff, that no queue item created since then asked
 * for, and whose latest sighting is not unlisted. The page brand comes from the capture's retained projection (only the
 * 09-13…09-29 captures kept one), the owner brand from the capture's owner. A listing whose captures all lack
 * observed_at is never a candidate.
 */
// Materialized so the planner hashes the skip set instead of re-running it per listing (68 s → 1.6 s on 10-24 data).
const CANDIDATES = `
WITH latest AS MATERIALIZED (
  SELECT DISTINCT ON (l.external_id) l.external_id AS listing_id, o.observation_id, o.observed_at
  FROM product_history_observation o JOIN product_history_listing l USING (listing_id)
  WHERE l.channel = $1 AND o.kind = 'metrics' AND o.record->>'source' = 'v3:amazon'
    AND l.external_id ~ '^[A-Z0-9]{10}$'
  ORDER BY l.external_id, o.observed_at DESC NULLS LAST, o.registered_at DESC),
skip AS MATERIALIZED (
  SELECT listing_id FROM queue_item WHERE channel = $1 AND created_at >= $2::timestamptz
  UNION
  SELECT listing_id FROM (
    SELECT DISTINCT ON (listing_id) listing_id, state FROM listing_state_observation
    WHERE channel = $1 ORDER BY listing_id, captured_at DESC) g WHERE g.state = 'unlisted'),
c AS MATERIALIZED (
  SELECT c.* FROM latest c LEFT JOIN skip k USING (listing_id)
  WHERE c.observed_at < $2::timestamptz AND k.listing_id IS NULL)
SELECT c.listing_id AS "listingId", c.observed_at AS "observedAt",
  r.record->'capture'->'projection'->>'brandRaw' AS "pageBrand",
  r.record->'owner'->>'brandId' AS "ownerBrandId",
  (SELECT q.source_id::text FROM queue_item q JOIN brand_source b ON b.id = q.source_id AND b.enabled
     WHERE q.channel = $1 AND q.listing_id = c.listing_id ORDER BY q.created_at DESC LIMIT 1) AS "queuedSourceId"
FROM c
LEFT JOIN LATERAL (
  SELECT s.record FROM product_history_observation_source os JOIN product_history_source s USING (source_record_id)
  WHERE os.observation_id = c.observation_id ORDER BY s.imported_at DESC LIMIT 1) r ON true
ORDER BY c.observed_at, c.listing_id`;

/** Read-only selection for `queue.recaptureHistory`; queueing goes through the shared queue store. */
export class PostgresHistoryRecapture implements HistoryRecaptureStore {
  constructor(private readonly database: Queryable) {}

  async recaptureCandidates(channel: "amazon", before: string): Promise<RecaptureCandidate[]> {
    const rows = await this.database.query(CANDIDATES, [channel, before]);
    return rows.map((row) => CandidateRow.parse(row));
  }

  async enabledSources(channel: "amazon"): Promise<RecaptureSource[]> {
    const rows = await this.database.query(
      `SELECT s.id::text AS "sourceId", b.id::text AS "brandId", b.name AS "brandName", s.url
       FROM brand_source s JOIN brand b ON b.id = s.brand_id
       WHERE s.channel = $1 AND s.enabled ORDER BY s.id`,
      [channel],
    );
    return rows.map((row) => SourceRow.parse(row));
  }
}
