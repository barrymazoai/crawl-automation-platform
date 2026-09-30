import {
  UnlistedReasonSchema,
  type ScanRecord,
  type ScanResult,
  type ScanRevisits,
  type ScanSource,
} from "@crawl-automation/app";
import { z } from "zod";

/** The columns a scan is read with: the scan, its source and its brand. */
export const SCAN_COLUMNS = `sc.scan_id::text AS "scanId", sc.request_id::text AS "requestId",
  s.id::text AS "sourceId", s.brand_id::text AS "brandId", b.name AS "brandName", sc.channel, sc.url,
  s.enabled, sc.revisit_batch_id::text AS "revisitBatchId", sc.state, sc.result,
  to_char(sc.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "requestedAt",
  to_char(sc.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt",
  to_char(sc.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "finishedAt"`;

export const SCAN_FROM = `brand_scan sc JOIN brand_source s ON s.id = sc.source_id JOIN brand b ON b.id = s.brand_id`;

export const SOURCE_COLUMNS = `s.id::text AS "sourceId", s.brand_id::text AS "brandId", b.name AS "brandName",
  s.channel, s.url, s.enabled`;

const SourceRow = z.object({
  sourceId: z.string(),
  brandId: z.string(),
  brandName: z.string(),
  channel: z.string(),
  url: z.string(),
  enabled: z.boolean(),
});

const ResultSchema = z.object({
  state: z.enum(["complete", "partial", "review"]),
  pages: z.number(),
  products: z.number(),
  families: z.number(),
  unresolvedFamilies: z.number(),
  statedTotal: z.number().nullable(),
  full: z.boolean(),
  capped: z.boolean().optional(),
  // Scans finished before these counts existed have neither.
  newListings: z.number().nullable().default(null),
  knownListings: z.number().nullable().default(null),
  missing: z.number(),
  queued: z.number(),
  credits: z.number(),
  code: z.string().nullable(),
});

const ScanRow = SourceRow.extend({
  scanId: z.string(),
  requestId: z.string(),
  revisitBatchId: z.string(),
  state: z.enum(["queued", "running", "complete", "partial", "review"]),
  result: ResultSchema.nullable(),
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export function sourceOf(row: unknown): ScanSource {
  return SourceRow.parse(row);
}

export function scanOf(row: unknown): ScanRecord {
  const parsed = ScanRow.parse(row);
  const { scanId, requestId, revisitBatchId, state, result, requestedAt, startedAt, finishedAt } =
    parsed;
  return {
    scanId,
    requestId,
    source: sourceOf(parsed),
    revisitBatchId,
    state,
    result: result satisfies ScanResult | null,
    requestedAt,
    startedAt,
    finishedAt,
  };
}

/**
 * A revisit list's outcome: the latest sighting of each of its listings recorded by the list's own runs, grouped by
 * state and reason, with the number of listings the list holds.
 */
export const REVISIT_OUTCOMES = `
  WITH runs AS (
    SELECT a.run_id FROM queue_attempt a JOIN queue_item i ON i.item_id = a.item_id WHERE i.batch_id = $1::uuid),
  latest AS (
    SELECT DISTINCT ON (o.listing_id, coalesce(o.variant_id, '')) o.state, o.reason
    FROM listing_state_observation o WHERE o.run_id IN (SELECT run_id FROM runs)
    ORDER BY o.listing_id, coalesce(o.variant_id, ''), o.captured_at DESC)
  SELECT (SELECT count(*)::int FROM queue_item WHERE batch_id = $1::uuid) AS requested,
    l.state, l.reason, count(*)::int AS count
  FROM latest l GROUP BY l.state, l.reason
  UNION ALL
  SELECT (SELECT count(*)::int FROM queue_item WHERE batch_id = $1::uuid), NULL, NULL, 0`;

const OutcomeRow = z.object({
  requested: z.number(),
  state: z.enum(["live", "unlisted"]).nullable(),
  reason: UnlistedReasonSchema.nullable(),
  count: z.number(),
});

export function revisitsOf(rows: unknown[]): ScanRevisits {
  const parsed = rows.map((row) => OutcomeRow.parse(row));
  const requested = parsed[0]?.requested ?? 0;
  const revisits: ScanRevisits = { requested, live: 0, unlisted: {}, pending: 0 };
  let seen = 0;
  for (const row of parsed) {
    seen += row.count;
    if (row.state === "live") {
      revisits.live += row.count;
    } else if (row.reason) {
      revisits.unlisted[row.reason] = (revisits.unlisted[row.reason] ?? 0) + row.count;
    }
  }
  revisits.pending = Math.max(0, requested - seen);
  return revisits;
}
