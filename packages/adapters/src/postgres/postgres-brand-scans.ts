import { cancelledScanResult } from "@crawl-automation/app";
import { PostgresScanCancellation } from "./postgres-scan-cancellation.js";
import { PostgresBrandSources } from "./postgres-brand-sources.js";
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
import { claimBrandScans } from "./brand-scan-claim.js";
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
export class PostgresBrandScans extends PostgresScanCancellation implements BrandScanStore {
  constructor(private readonly database: Database) {
    super(database);
  }

  async sources(sourceIds: readonly string[]): Promise<ScanSource[]> {
    return new PostgresBrandSources(this.database).byIds(sourceIds);
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

  async claim(
    limit: number,
    staleMs: number,
    active: readonly string[] = [],
  ): Promise<ScanRecord[]> {
    const claimed = await this.database.transaction((tx) =>
      claimBrandScans(tx, { limit, staleMs, active }),
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
      `UPDATE brand_scan SET
         state = CASE WHEN cancellation_requested_at IS NULL THEN $2 ELSE 'cancelled' END,
         result = CASE WHEN cancellation_requested_at IS NULL THEN $3::jsonb ELSE $5::jsonb END,
         code = CASE WHEN cancellation_requested_at IS NULL THEN $4 ELSE $5::jsonb->>'code' END,
         finished_at = clock_timestamp()
       WHERE scan_id = $1::uuid AND finished_at IS NULL`,
      [
        scanId,
        result.state,
        JSON.stringify(result),
        result.code,
        JSON.stringify(cancelledScanResult(result)),
      ],
    );
  }

  async list(query: ScanListQuery): Promise<ScanRecord[]> {
    const rows = await this.database.query(
      `SELECT ${SCAN_COLUMNS} FROM ${SCAN_FROM}
       WHERE ($1::text IS NULL OR sc.channel = $1) AND ($2::text IS NULL OR sc.state = $2)
         AND ($4::uuid IS NULL OR sc.source_id = $4)
       ORDER BY sc.requested_at DESC LIMIT $3`,
      [query.channel ?? null, query.state ?? null, query.limit, query.sourceId ?? null],
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

  async byRequest(requestId: string, sourceId: string): Promise<ScanRecord | null> {
    const rows = await this.database.query(
      `SELECT ${SCAN_COLUMNS} FROM ${SCAN_FROM}
       WHERE sc.request_id = $1::uuid AND sc.source_id = $2::uuid`,
      [requestId, sourceId],
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
