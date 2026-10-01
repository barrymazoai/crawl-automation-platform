import {
  HtmlCaptureRequestSchema,
  SavedHtmlOriginalSchema,
  type HtmlCaptureRequest,
  type SavedHtmlOriginal,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { captureCreditCost } from "./html-capture-cost.js";

const IDENTITY = "channel=$1 AND listing_id=$2 AND variant_id IS NOT DISTINCT FROM $3";

export interface HtmlCaptureRow {
  request: unknown;
  state: "in_flight" | "done" | "failed";
  original: unknown;
  cause_code: string | null;
}

export async function readCapture(database: Queryable, operationId: string) {
  const rows = await database.query<HtmlCaptureRow>(
    "SELECT request, state, original, cause_code FROM html_capture WHERE operation_id=$1",
    [operationId],
  );
  return rows[0];
}

export async function recentOriginal(
  database: Queryable,
  request: HtmlCaptureRequest,
  windowMs: number,
) {
  const rows = await database.query<{ original: unknown }>(
    `SELECT original FROM html_capture WHERE ${IDENTITY} AND state='done'
       AND captured_at > clock_timestamp() - $4::bigint * interval '1 millisecond'
       AND captured_at <= clock_timestamp() ORDER BY captured_at DESC LIMIT 1`,
    [...identityValues(request), windowMs],
  );
  return rows[0] ? SavedHtmlOriginalSchema.parse(rows[0].original) : null;
}

export async function inFlight(database: Queryable, request: HtmlCaptureRequest) {
  const rows = await database.query<{ operation_id: string }>(
    `SELECT operation_id FROM html_capture WHERE ${IDENTITY} AND state='in_flight'
       AND requested_at > clock_timestamp() - interval '10 minutes'
       ORDER BY requested_at DESC LIMIT 1`,
    identityValues(request),
  );
  return rows[0]?.operation_id;
}

/** Called after excluding live requests; unfinished archives may outlive a lost ledger write. */
export async function unfinishedCaptures(database: Queryable, request: HtmlCaptureRequest) {
  const rows = await database.query<{ request: unknown }>(
    `SELECT request FROM html_capture WHERE ${IDENTITY} AND state='in_flight'
       ORDER BY requested_at DESC`,
    identityValues(request),
  );
  return rows.map((row) => HtmlCaptureRequestSchema.parse(row.request));
}

/** A reused operation stores the same reference and timestamp, never a new original. */
export async function insertCapture(
  database: Queryable,
  request: HtmlCaptureRequest,
  original: SavedHtmlOriginal | null,
) {
  await database.query(
    `INSERT INTO html_capture
       (channel,listing_id,variant_id,operation_id,request,state,original,captured_at,credit_cost,reused)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      ...identityValues(request),
      request.capture.operationId,
      request,
      original ? "done" : "in_flight",
      original,
      original?.capturedAt ?? null,
      captureCreditCost(request, original),
      original ? original.capture.operationId !== request.capture.operationId : false,
    ],
  );
}

function identityValues(request: HtmlCaptureRequest) {
  return [request.channel, request.capture.listingId, request.capture.variantId];
}
