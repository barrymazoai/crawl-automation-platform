import {
  cancelledScanResult,
  type CancelScans,
  type CancelScanCounts,
} from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";

/** One locked mutation: queued rows terminate now; running executors acknowledge at a safe boundary. */
export class PostgresScanCancellation {
  constructor(private readonly cancellationDatabase: Database) {}

  async cancel(query: CancelScans): Promise<CancelScanCounts> {
    const rows = await this.cancellationDatabase.query<CancelScanCounts>(
      `WITH selected AS MATERIALIZED (
         SELECT scan_id, state FROM brand_scan
         WHERE state IN ('queued', 'running') AND cancellation_requested_at IS NULL
           AND ($1::uuid[] IS NULL OR scan_id = ANY($1::uuid[]))
           AND ($2::uuid IS NULL OR request_id = $2::uuid)
           AND ($3::text IS NULL OR channel = $3)
         ORDER BY scan_id FOR UPDATE),
       updated AS (
         UPDATE brand_scan sc SET cancellation_requested_at = clock_timestamp(),
           state = CASE WHEN selected.state = 'queued' THEN 'cancelled' ELSE sc.state END,
           result = CASE WHEN selected.state = 'queued' THEN $4::jsonb ELSE sc.result END,
           code = CASE WHEN selected.state = 'queued' THEN $4::jsonb->>'code' ELSE sc.code END,
           finished_at = CASE WHEN selected.state = 'queued' THEN clock_timestamp() ELSE NULL END
         FROM selected WHERE sc.scan_id = selected.scan_id RETURNING selected.state)
       SELECT count(*) FILTER (WHERE state = 'queued')::int AS cancelled,
         count(*) FILTER (WHERE state = 'running')::int AS "cancellationRequested" FROM updated`,
      [
        query.scanIds ?? null,
        query.requestId ?? null,
        query.channel ?? null,
        JSON.stringify(cancelledScanResult()),
      ],
    );
    return rows[0] ?? { cancelled: 0, cancellationRequested: 0 };
  }

  async isCancellationRequested(scanId: string): Promise<boolean> {
    const rows = await this.cancellationDatabase.query<{ requested: boolean }>(
      `SELECT cancellation_requested_at IS NOT NULL OR state = 'cancelled' AS requested
       FROM brand_scan WHERE scan_id = $1::uuid`,
      [scanId],
    );
    return rows[0]?.requested === true;
  }
}
