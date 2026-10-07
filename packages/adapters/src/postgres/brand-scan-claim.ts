import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";
import { DTC_HELD_BROWSER_PERMITS } from "./dtc-scan-queries.js";

/** The same per-source priority the product queue uses (CRAWLV3-210); no row is priority 0. */
const SOURCE_PRIORITY = `coalesce((SELECT p.priority FROM queue_source_priority p
  WHERE p.channel = brand_scan.channel AND p.source_id = brand_scan.source_id), 0)`;
const STALE = `started_at < clock_timestamp() - $1::int * interval '1 millisecond'`;

type Claim = { limit: number; staleMs: number; active?: readonly string[] };

/**
 * Scans start by source priority, then oldest first (owner 2026-10-07, CRAWLV3-213). DTC and Costco each have a
 * single slot (one browser each); the other channels share the rest. The pick is materialized once, so a claim never
 * takes more than `limit` scans, and scans the caller is still running are never taken over as stale.
 */
export async function claimBrandScans(tx: Queryable, settings: Claim) {
  const active = [...(settings.active ?? [])];
  const dtc = await dtcCandidate(tx, settings.staleMs, active);
  const costco = await costcoCandidate(tx, settings.staleMs, active);
  return tx.query<{ scanId: string }>(
    `WITH picked AS MATERIALIZED (
       SELECT scan_id FROM brand_scan
       WHERE channel NOT IN ('dtc','costco') AND scan_id <> ALL($4::uuid[]) AND (state='queued' OR
         (state='running' AND started_at < clock_timestamp() - $2::int * interval '1 millisecond'))
       ORDER BY ${SOURCE_PRIORITY} DESC, requested_at, scan_id
       LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE brand_scan SET state='running',started_at=clock_timestamp()
     WHERE state IN ('queued','running')
       AND (scan_id IN (SELECT scan_id FROM picked) OR scan_id IN ($3::uuid, $5::uuid))
     RETURNING scan_id::text AS "scanId"`,
    [settings.limit, settings.staleMs, dtc, active, costco],
  );
}

/** One DTC task globally; stale running rows reconnect their fixed workflow even while paused. */
async function dtcCandidate(tx: Queryable, staleMs: number, active: string[]) {
  const control = z
    .object({ mode: z.enum(["paused", "running"]) })
    .parse((await tx.query("SELECT mode FROM dtc_scan_control WHERE singleton FOR UPDATE"))[0]);
  const rows = await tx.query<{ scanId: string }>(
    `SELECT scan_id AS "scanId" FROM brand_scan
     WHERE channel='dtc' AND scan_id <> ALL($3::uuid[]) AND (
       (state='running' AND ${STALE})
       OR (state='queued' AND $2::boolean
         AND NOT EXISTS (SELECT 1 FROM brand_scan WHERE channel='dtc' AND state='running')
         AND NOT EXISTS (${DTC_HELD_BROWSER_PERMITS})))
     ORDER BY ${SOURCE_PRIORITY} DESC, requested_at, scan_id LIMIT 1`,
    [staleMs, control.mode === "running", active],
  );
  return rows[0]?.scanId ?? null;
}

/** Costco scans share one browser: one at a time, so its queue never holds every slot. */
async function costcoCandidate(tx: Queryable, staleMs: number, active: string[]) {
  const rows = await tx.query<{ scanId: string }>(
    `SELECT scan_id AS "scanId" FROM brand_scan
     WHERE channel='costco' AND scan_id <> ALL($2::uuid[])
       AND NOT EXISTS (SELECT 1 FROM brand_scan r WHERE r.channel='costco' AND r.scan_id = ANY($2::uuid[]))
       AND ((state='running' AND ${STALE})
         OR (state='queued' AND NOT EXISTS (SELECT 1 FROM brand_scan r WHERE r.channel='costco'
           AND r.state='running' AND r.started_at >= clock_timestamp() - $1::int * interval '1 millisecond')))
     ORDER BY ${SOURCE_PRIORITY} DESC, requested_at, scan_id LIMIT 1`,
    [staleMs, active],
  );
  return rows[0]?.scanId ?? null;
}
