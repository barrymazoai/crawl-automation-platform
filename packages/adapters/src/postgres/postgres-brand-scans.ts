import type {
  BrandScanStore,
  QueuedProduct,
  ScanChannel,
  ScanListQuery,
  ScanRecord,
  ScanResult,
  ScanRevisits,
  ScanSource,
} from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { z } from "zod";
import {
  REVISIT_OUTCOMES,
  SCAN_COLUMNS,
  SCAN_FROM,
  SOURCE_COLUMNS,
  revisitsOf,
  scanOf,
  sourceOf,
} from "./brand-scan-queries.js";

const KnownRow = z.object({
  sourceId: z.string(),
  url: z.string(),
  listingId: z.string(),
  variantId: z.string().nullable(),
});

/** `brand_scan` and the brand sources it reads. A finished scan is never changed (the table's trigger). */
export class PostgresBrandScans implements BrandScanStore {
  constructor(private readonly database: Database) {}

  async sources(sourceIds: readonly string[]): Promise<ScanSource[]> {
    const rows = await this.database.query(
      `SELECT ${SOURCE_COLUMNS} FROM brand_source s JOIN brand b ON b.id = s.brand_id
       WHERE s.id = ANY($1::uuid[])`,
      [sourceIds],
    );
    return rows.map(sourceOf);
  }

  async enabledSources(channel: ScanChannel): Promise<ScanSource[]> {
    const rows = await this.database.query(
      `SELECT ${SOURCE_COLUMNS} FROM brand_source s JOIN brand b ON b.id = s.brand_id
       WHERE s.channel = $1 AND s.enabled ORDER BY b.name`,
      [channel],
    );
    return rows.map(sourceOf);
  }

  async request(requestId: string, sources: readonly ScanSource[]): Promise<ScanRecord[]> {
    const ids = sources.map((source) => source.sourceId);
    await this.database.query(
      `INSERT INTO brand_scan (request_id, source_id, channel, url)
       SELECT $1::uuid, x.source_id, x.channel, x.url
       FROM unnest($2::uuid[], $3::text[], $4::text[]) AS x(source_id, channel, url)
       ON CONFLICT (request_id, source_id) DO NOTHING`,
      [
        requestId,
        ids,
        sources.map((source) => source.channel),
        sources.map((source) => source.url),
      ],
    );
    const rows = await this.database.query(
      `SELECT ${SCAN_COLUMNS} FROM ${SCAN_FROM}
       WHERE sc.request_id = $1::uuid AND sc.source_id = ANY($2::uuid[]) ORDER BY b.name`,
      [requestId, ids],
    );
    return rows.map(scanOf);
  }

  async claim(limit: number, staleMs: number): Promise<ScanRecord[]> {
    const claimed = await this.database.query<{ scanId: string }>(
      `UPDATE brand_scan SET state = 'running', started_at = clock_timestamp()
       WHERE scan_id IN (
         SELECT scan_id FROM brand_scan
         WHERE state = 'queued'
            OR (state = 'running' AND started_at < clock_timestamp() - $2::int * interval '1 millisecond')
         ORDER BY requested_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING scan_id::text AS "scanId"`,
      [limit, staleMs],
    );
    if (claimed.length === 0) {
      return [];
    }
    const rows = await this.database.query(
      `SELECT ${SCAN_COLUMNS} FROM ${SCAN_FROM} WHERE sc.scan_id = ANY($1::uuid[]) ORDER BY sc.requested_at`,
      [claimed.map((row) => row.scanId)],
    );
    return rows.map(scanOf);
  }

  async finish(scanId: string, result: ScanResult): Promise<void> {
    await this.database.query(
      `UPDATE brand_scan SET state = $2, result = $3::jsonb, code = $4, finished_at = clock_timestamp()
       WHERE scan_id = $1::uuid AND finished_at IS NULL`,
      [scanId, result.state, JSON.stringify(result), result.code],
    );
  }

  async list(query: ScanListQuery): Promise<ScanRecord[]> {
    const rows = await this.database.query(
      `SELECT ${SCAN_COLUMNS} FROM ${SCAN_FROM}
       WHERE ($1::text IS NULL OR sc.channel = $1) AND ($2::text IS NULL OR sc.state = $2)
       ORDER BY sc.requested_at DESC LIMIT $3`,
      [query.channel ?? null, query.state ?? null, query.limit],
    );
    return rows.map(scanOf);
  }

  async get(scanId: string): Promise<ScanRecord | null> {
    const rows = await this.database.query(
      `SELECT ${SCAN_COLUMNS} FROM ${SCAN_FROM} WHERE sc.scan_id = $1::uuid`,
      [scanId],
    );
    return rows[0] ? scanOf(rows[0]) : null;
  }

  async revisits(revisitBatchId: string): Promise<ScanRevisits> {
    return revisitsOf(await this.database.query(REVISIT_OUTCOMES, [revisitBatchId]));
  }

  /** The source's listings queued by earlier lists: the latest address of each listing and variant. */
  async knownListings(source: ScanSource, exceptBatchId: string): Promise<QueuedProduct[]> {
    const rows = await this.database.query(
      `SELECT DISTINCT ON (listing_id, coalesce(variant_id, ''))
         source_id::text AS "sourceId", url, listing_id AS "listingId", variant_id AS "variantId"
       FROM queue_item WHERE channel = $1 AND source_id = $2::uuid AND batch_id <> $3::uuid
       ORDER BY listing_id, coalesce(variant_id, ''), created_at DESC`,
      [source.channel, source.sourceId, exceptBatchId],
    );
    return rows.map((row) => KnownRow.parse(row));
  }
}
