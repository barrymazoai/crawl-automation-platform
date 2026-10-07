import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";
import { DTC_HELD_BROWSER_PERMITS } from "./dtc-scan-queries.js";

/** The same per-source priority the product queue uses (CRAWLV3-210); no row is priority 0. */
const SOURCE_PRIORITY = `coalesce((SELECT p.priority FROM queue_source_priority p
  WHERE p.channel = brand_scan.channel AND p.source_id = brand_scan.source_id), 0)`;

/**
 * One DTC task globally; stale running rows reconnect their fixed workflow even while paused. Scans start by source
 * priority, then oldest first (owner 2026-10-07, CRAWLV3-213). The pick is materialized once, so a claim never takes
 * more than `limit` scans, and scans the caller is still running are never taken over as stale.
 */
export async function claimBrandScans(
  tx: Queryable,
  settings: { limit: number; staleMs: number; active?: readonly string[] },
) {
  const active = [...(settings.active ?? [])];
  const control = z
    .object({ mode: z.enum(["paused", "running"]) })
    .parse((await tx.query("SELECT mode FROM dtc_scan_control WHERE singleton FOR UPDATE"))[0]);
  const candidate = await tx.query<{ scanId: string }>(
    `SELECT scan_id AS "scanId" FROM brand_scan
     WHERE channel='dtc' AND scan_id <> ALL($3::uuid[]) AND (
       (state='running' AND started_at < clock_timestamp() - $1::int * interval '1 millisecond')
       OR (state='queued' AND $2::boolean
         AND NOT EXISTS (SELECT 1 FROM brand_scan WHERE channel='dtc' AND state='running')
         AND NOT EXISTS (${DTC_HELD_BROWSER_PERMITS})))
     ORDER BY ${SOURCE_PRIORITY} DESC, requested_at, scan_id LIMIT 1`,
    [settings.staleMs, control.mode === "running", active],
  );
  return tx.query<{ scanId: string }>(
    `WITH picked AS MATERIALIZED (
       SELECT scan_id FROM brand_scan
       WHERE channel<>'dtc' AND scan_id <> ALL($4::uuid[]) AND (state='queued' OR
         (state='running' AND started_at < clock_timestamp() - $2::int * interval '1 millisecond'))
       ORDER BY ${SOURCE_PRIORITY} DESC, requested_at, scan_id
       LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE brand_scan SET state='running',started_at=clock_timestamp()
     WHERE state IN ('queued','running')
       AND (scan_id IN (SELECT scan_id FROM picked) OR scan_id=$3::uuid)
     RETURNING scan_id::text AS "scanId"`,
    [settings.limit, settings.staleMs, candidate[0]?.scanId ?? null, active],
  );
}
