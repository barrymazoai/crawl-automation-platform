import {
  QueueStateSchema,
  type QueueSourceSummary,
  type QueueSummaryQuery,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";

const SummaryRow = z.object({
  sourceId: z.uuid(),
  brandId: z.uuid(),
  brandName: z.string(),
  state: QueueStateSchema.nullable(),
  reason: z.string().nullable(),
  count: z.number().int().nonnegative(),
});

/** Counts queue rows once, without multiplying them by historical scans or attempts. */
export class PostgresQueueSummary {
  constructor(private readonly database: Queryable) {}

  async summary(query: QueueSummaryQuery): Promise<QueueSourceSummary[]> {
    const rows = await this.database.query(
      `SELECT s.id::text AS "sourceId", b.id::text AS "brandId", b.name AS "brandName",
         i.state, CASE WHEN i.state = 'review' THEN i.reason END AS reason,
         count(i.item_id)::int AS count
       FROM brand_source s JOIN brand b ON b.id = s.brand_id
       LEFT JOIN queue_item i ON i.source_id = s.id AND i.channel = $1
         AND ($3::timestamptz IS NULL OR i.created_at >= $3)
         AND ($4::uuid IS NULL OR EXISTS (
           SELECT 1 FROM brand_scan scan WHERE scan.request_id = $4 AND scan.channel = $1
             AND scan.source_id = s.id AND scan.scan_id = i.batch_id))
       WHERE s.channel = $1 AND ($2::uuid[] IS NULL OR s.id = ANY($2))
         AND ($4::uuid IS NULL OR EXISTS (
           SELECT 1 FROM brand_scan scan WHERE scan.request_id = $4
             AND scan.source_id = s.id AND scan.channel = $1))
       GROUP BY s.id, b.id, i.state, CASE WHEN i.state = 'review' THEN i.reason END
       ORDER BY b.name, s.id, i.state, count(i.item_id) DESC, reason`,
      [query.channel, query.sourceIds ?? null, query.createdSince ?? null, query.requestId ?? null],
    );
    return this.group(rows.map((row) => SummaryRow.parse(row)));
  }

  private group(rows: z.infer<typeof SummaryRow>[]): QueueSourceSummary[] {
    const sources = new Map<string, QueueSourceSummary>();
    for (const row of rows) {
      const summary = sources.get(row.sourceId) ?? {
        sourceId: row.sourceId,
        brandId: row.brandId,
        brandName: row.brandName,
        total: 0,
        counts: {},
        reviewReasons: [],
      };
      sources.set(row.sourceId, summary);
      if (row.state === null) {
        continue;
      }
      summary.total += row.count;
      summary.counts[row.state] = (summary.counts[row.state] ?? 0) + row.count;
      if (row.state === "review") {
        summary.reviewReasons.push({ reason: row.reason, count: row.count });
      }
    }
    return [...sources.values()];
  }
}
