import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";
import { DTC_HELD_SCAN } from "./dtc-scan-queries.js";

/** One DTC task globally; stale running rows reconnect their fixed workflow even while paused. */
export async function claimBrandScans(tx: Queryable, settings: { limit: number; staleMs: number }) {
  const control = z
    .object({ mode: z.enum(["paused", "running"]) })
    .parse((await tx.query("SELECT mode FROM dtc_scan_control WHERE singleton FOR UPDATE"))[0]);
  const candidate = await tx.query<{ scanId: string }>(
    `SELECT scan_id AS "scanId" FROM brand_scan
     WHERE channel='dtc' AND (
       (state='running' AND started_at < clock_timestamp() - $1::int * interval '1 millisecond')
       OR (state='queued' AND $2::boolean
         AND NOT EXISTS (SELECT 1 FROM brand_scan WHERE channel='dtc' AND state='running')
         AND NOT EXISTS (${DTC_HELD_SCAN})))
     ORDER BY requested_at,scan_id LIMIT 1`,
    [settings.staleMs, control.mode === "running"],
  );
  return tx.query<{ scanId: string }>(
    `UPDATE brand_scan SET state='running',started_at=clock_timestamp()
     WHERE state IN ('queued','running') AND scan_id IN (
       SELECT scan_id FROM brand_scan WHERE scan_id=$3::uuid OR
         (channel<>'dtc' AND (state='queued' OR
           (state='running' AND started_at < clock_timestamp() - $2::int * interval '1 millisecond')))
       ORDER BY requested_at,scan_id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING scan_id::text AS "scanId"`,
    [settings.limit, settings.staleMs, candidate[0]?.scanId ?? null],
  );
}
