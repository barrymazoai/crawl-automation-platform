import type { SettleReview, SettleReviewResult } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

interface Candidate {
  itemId: string;
  state: string;
  collected: boolean;
}

/** Called under the channel queue lock; preview and mutation inspect the same rows. */
export class PostgresQueueOwnerSettle {
  constructor(private readonly tx: Queryable) {}

  async settle(input: SettleReview): Promise<SettleReviewResult> {
    const ids = [...new Set(input.itemIds)];
    const rows = await this.candidates(input, ids);
    const eligible = rows.filter((row) => row.state === "review" && !row.collected);
    if (!input.dryRun && eligible.length) {
      await this.update(input, eligible);
    }
    return {
      dryRun: input.dryRun,
      matched: rows.length,
      settled: eligible.length,
      skipped: {
        notReview: rows.filter((row) => row.state !== "review").length,
        collected: rows.filter((row) => row.state === "review" && row.collected).length,
        notFound: ids.length - rows.length,
      },
    };
  }

  /**
   * A listing (and website variant) that already has a collected product keeps its Review: settling it outside
   * supplements would make the latest outcome contradict a product that may already be delivered.
   */
  private candidates(input: SettleReview, ids: string[]): Promise<Candidate[]> {
    return this.tx.query<Candidate>(
      `SELECT q.item_id AS "itemId", q.state,
         EXISTS (SELECT 1 FROM queue_item c WHERE c.channel = q.channel AND c.listing_id = q.listing_id
           AND c.variant_id IS NOT DISTINCT FROM q.variant_id AND c.state = 'completed' AND c.reason IS NULL)
         OR EXISTS (SELECT 1 FROM product_sync ps WHERE ps.channel = q.channel AND ps.listing_id = q.listing_id
           AND ps.variant_key = coalesce(q.variant_id, '') AND ps.supply_smart_product_id IS NOT NULL)
         AS collected
       FROM queue_item q WHERE q.channel = $1 AND q.item_id = ANY($2::text[])
       ORDER BY q.item_id FOR UPDATE OF q`,
      [input.channel, ids],
    );
  }

  private async update(input: SettleReview, eligible: Candidate[]): Promise<void> {
    const updated = await this.tx.query<{ item_id: string }>(
      `UPDATE queue_item SET state = 'completed', reason = $3, owner_note = $4,
         owner_settled_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE channel = $1 AND item_id = ANY($2::text[]) AND state = 'review'
       RETURNING item_id`,
      [input.channel, eligible.map((row) => row.itemId), input.reason, input.note],
    );
    if (updated.length !== eligible.length) {
      throw new Error("Owner settlement selection changed under the channel lock");
    }
  }
}
