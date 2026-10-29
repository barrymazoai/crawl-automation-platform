import type {
  RoundBatchRow,
  RoundPushRow,
  RoundReader,
  RoundScanRow,
  RoundSnapshot,
} from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";

/** Every time is text in one ISO form (milliseconds, Z), so the app compares and sorts them as strings. */
const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * A list's queue items by current state; an item belongs to the list that first added it. The first run of each item
 * decides when the list's work settled, so a requeue weeks later does not move the round's end. An item settled
 * without an attempt of its own (a family follower) settles with its leader and sets no time.
 */
const batchesQuery = `
SELECT lb.channel, lb.batch_id::text AS "batchId", ${iso("lb.created_at")} AS "createdAt",
  CASE WHEN EXISTS (SELECT 1 FROM brand_scan s WHERE s.scan_id = lb.batch_id) THEN 'scan'
       WHEN EXISTS (SELECT 1 FROM brand_scan s WHERE s.revisit_batch_id = lb.batch_id) THEN 'revisit'
       ELSE 'list' END AS kind,
  lb.item_count AS items,
  count(qi.item_id) FILTER (WHERE qi.state IN ('queued', 'ready', 'running'))::int AS open,
  count(qi.item_id) FILTER (WHERE qi.state = 'completed')::int AS completed,
  count(qi.item_id) FILTER (WHERE qi.state = 'review')::int AS review,
  count(qi.item_id) FILTER (
    WHERE qi.state IN ('queued', 'ready', 'running') AND first.settled_at IS NULL)::int AS "firstOpen",
  ${iso("max(first.settled_at)")} AS "firstSettledAt"
FROM link_batch lb
LEFT JOIN queue_item qi ON qi.batch_id = lb.batch_id
LEFT JOIN queue_attempt first ON first.item_id = qi.item_id AND first.attempt = 1
WHERE lb.created_at >= $1::timestamptz AND ($2::text IS NULL OR lb.channel = $2)
GROUP BY lb.batch_id`;

const scansQuery = `
SELECT channel, source_id::text AS "sourceId", ${iso("requested_at")} AS "requestedAt", ${iso("finished_at")} AS "finishedAt", state
FROM brand_scan WHERE requested_at >= $1::timestamptz AND ($2::text IS NULL OR channel = $2)`;

/**
 * Marketplace sync runs are named marketplace-sync-<channel>-<ISO start>; their time is that start. DTC products go
 * through brand enrichment deliveries (ingest run brand-enrichment-<run>; a run with several catalog domains suffixes
 * each domain, which the step output does not record).
 */
const pushesQuery = `
SELECT channel, ingest_run_id AS "runId",
  ${iso("COALESCE(substring(ingest_run_id FROM '\\d{4}-\\d\\d-\\d\\dT[0-9:.]+Z$')::timestamptz, min(updated_at))")} AS at,
  count(*) FILTER (WHERE status = 'verified')::int AS verified,
  count(*) FILTER (WHERE status = 'failed')::int AS failed,
  count(*) FILTER (WHERE status = 'sent')::int AS sent
FROM product_sync
WHERE ingest_run_id IS NOT NULL AND status IN ('verified', 'failed', 'sent')
  AND updated_at >= $1::timestamptz AND ($2::text IS NULL OR channel = $2)
GROUP BY channel, ingest_run_id
UNION ALL
SELECT 'dtc', 'brand-enrichment-' || run_id::text, ${iso("created_at")},
  COALESCE((output->>'delivered')::int, 0), COALESCE(jsonb_array_length(output->'refused'), 0), 0
FROM brand_enrichment_step
WHERE step ~ '^products(@[0-9]+|-retry@[0-9]+|-redelivery-.+)?$' AND output ? 'delivered'
  AND created_at >= $1::timestamptz AND ($2::text IS NULL OR $2 = 'dtc')`;

/** One read-only repeatable snapshot, so a round's lists, scans and pushes agree with each other. */
export class PostgresRoundReader implements RoundReader {
  constructor(private readonly database: Database) {}

  read(input: { since: string; channel?: string | undefined }): Promise<RoundSnapshot> {
    return this.database.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const values = [input.since, input.channel ?? null];
      const [now] = await transaction.query<{ readAt: string }>(
        `SELECT ${iso("now()")} AS "readAt"`,
      );
      return {
        readAt: now?.readAt ?? new Date().toISOString(),
        batches: await transaction.query<RoundBatchRow>(batchesQuery, values),
        scans: await transaction.query<RoundScanRow>(scansQuery, values),
        pushes: await transaction.query<RoundPushRow>(pushesQuery, values),
      };
    });
  }
}
