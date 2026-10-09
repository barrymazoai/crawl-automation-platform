import type { BrandRedeliveryCandidates } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { latestProductAttemptSql } from "./brand-product-attempt-sql.js";

export class PostgresBrandRedeliveryCandidates implements BrandRedeliveryCandidates {
  constructor(private readonly database: Queryable) {}

  async findPending(completedSince: Date): Promise<string[]> {
    // Old deliveries have only the step time. No delivery yet means every completed item is eligible.
    const rows = await this.database.query<{ runId: string }>(
      `SELECT run.id AS "runId"
       FROM brand_enrichment_run run
       CROSS JOIN LATERAL (${latestProductAttemptSql}run.id) latest
       JOIN brand_enrichment_step sources ON sources.run_id = run.id
         AND sources.step = CASE WHEN latest.attempt = 1 THEN 'product-sources'
           ELSE 'product-sources@' || latest.attempt END
       CROSS JOIN LATERAL (
         SELECT max(COALESCE((output->>'deliveryStartedAt')::timestamptz, created_at)) AS delivered_at
         FROM brand_enrichment_step
         WHERE run_id = run.id AND (
           step = CASE WHEN latest.attempt = 1 THEN 'products' ELSE 'products@' || latest.attempt END
           OR (step LIKE 'products-redelivery-%' AND COALESCE((output->>'attempt')::int, 1) = latest.attempt)
         )
       ) delivery
       WHERE run.state = 'completed' AND run.updated_at >= $1
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(sources.output->'tasks', '[]'::jsonb)) task
           JOIN queue_item item ON item.source_id = (task->>'sourceId')::uuid
           WHERE item.channel = 'dtc' AND item.state = 'completed'
             AND item.updated_at > COALESCE(delivery.delivered_at, '-infinity'::timestamptz)
         )
       ORDER BY run.updated_at, run.id`,
      [completedSince],
    );
    return rows.map((row) => row.runId);
  }
}
