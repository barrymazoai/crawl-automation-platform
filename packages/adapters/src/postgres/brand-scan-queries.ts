import type { ScanRecord, ScanResult, ScanSource } from "@crawl-automation/app";
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
    result: result as ScanResult | null,
    requestedAt,
    startedAt,
    finishedAt,
  };
}
