import {
  SourceScanViewSchema,
  type ListSourcesSchema,
  type ScanSource,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import type { z } from "zod";
import { SOURCE_COLUMNS, sourceOf } from "./brand-scan-queries.js";

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

/** Paged source configuration with latest-request facts and all-time queue-row counts. */
export class PostgresBrandSources {
  constructor(private readonly database: Queryable) {}

  async byIds(sourceIds: readonly string[]): Promise<ScanSource[]> {
    const rows = await this.database.query(
      `SELECT ${SOURCE_COLUMNS} FROM brand_source s JOIN brand b ON b.id = s.brand_id
       WHERE s.id = ANY($1::uuid[])`,
      [sourceIds],
    );
    return rows.map(sourceOf);
  }

  async sources(query: z.infer<typeof ListSourcesSchema>) {
    const rows = await this.database.query<Record<string, unknown>>(
      `WITH selected AS (
         SELECT s.* FROM brand_source s
         WHERE ($1::uuid IS NULL OR s.brand_id = $1)
           AND ($2::text IS NULL OR s.channel = $2)
           AND ($3::boolean IS NULL OR s.enabled = $3)
           AND ($4::boolean IS NULL OR EXISTS (
             SELECT 1 FROM brand_scan scan WHERE scan.source_id = s.id) = $4)
           AND strpos(lower(s.url), lower($5)) > 0
         ORDER BY s.created_at, s.id LIMIT $6 OFFSET $7)
       SELECT s.id, s.brand_id AS "brandId", b.name AS "brandName", s.channel, s.region,
         s.url, s.enabled, s.revision, s.created_at AS "createdAt", s.updated_at AS "updatedAt",
         scan.scan_id AS "scanId", scan.request_id AS "requestId", scan.state AS "scanState",
         scan.requested_at AS "requestedAt", scan.started_at AS "startedAt",
         scan.finished_at AS "finishedAt",
         (SELECT count(*)::int FROM queue_item i WHERE i.source_id = s.id) AS "queueProductCount"
       FROM selected s JOIN brand b ON b.id = s.brand_id
       LEFT JOIN LATERAL (SELECT * FROM brand_scan WHERE source_id = s.id
         ORDER BY requested_at DESC, scan_id DESC LIMIT 1) scan ON true
       ORDER BY s.created_at, s.id`,
      [
        query.brandId ?? null,
        query.channel ?? null,
        query.enabled ?? null,
        query.scanned ?? null,
        query.q,
        query.limit + 1,
        query.offset,
      ],
    );
    return {
      items: rows.slice(0, query.limit).map((row) => this.toSource(row)),
      limit: query.limit,
      offset: query.offset,
      hasMore: rows.length > query.limit,
    };
  }

  private toSource(row: Record<string, unknown>) {
    const { scanId, requestId, scanState, requestedAt, startedAt, finishedAt, ...source } = row;
    return SourceScanViewSchema.parse({
      ...source,
      createdAt: iso(source.createdAt),
      updatedAt: iso(source.updatedAt),
      lastScan:
        scanId === null
          ? null
          : {
              scanId,
              requestId,
              state: scanState,
              requestedAt: iso(requestedAt),
              startedAt: iso(startedAt),
              finishedAt: iso(finishedAt),
            },
    });
  }
}
