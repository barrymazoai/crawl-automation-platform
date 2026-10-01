import { appErrors, type Requeue, type RequeueResult } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { PostgresQueueReader } from "./postgres-queue-reader.js";

/** Called under the existing channel lock, with selection and mutation in the same transaction. */
export class PostgresQueueRequeue {
  constructor(private readonly transaction: Queryable) {}

  async requeue(input: Requeue): Promise<RequeueResult> {
    if ("itemIds" in input) {
      return this.enqueueIds(input);
    }
    const selected = await new PostgresQueueReader(this.transaction).items(
      {
        ...input.filter,
        channel: input.channel,
        state: "review",
        limit: input.limit,
      },
      true,
    );
    if (input.dryRun) {
      // Count means the bounded selection that would be requeued, not all matches beyond the limit.
      return { dryRun: true, count: selected.length, sample: selected.slice(0, 20) };
    }
    return this.enqueueIds({
      channel: input.channel,
      itemIds: selected.map((item) => item.itemId),
    });
  }

  /** The original requeue path, shared by explicit IDs and the locked Review selection. */
  private async enqueueIds(input: Extract<Requeue, { itemIds: string[] }>) {
    if (input.itemIds.length === 0) {
      return { requeued: 0 };
    }
    const rows = await this.transaction.query<{ state: string }>(
      "SELECT state FROM queue_item WHERE channel = $1 AND item_id = ANY($2::text[]) FOR UPDATE",
      [input.channel, input.itemIds],
    );
    const settled = rows.every((row) => ["completed", "review", "pending"].includes(row.state));
    if (rows.length !== new Set(input.itemIds).size || !settled) {
      throw appErrors.create("QUEUE.REQUEUE_NOT_SETTLED");
    }
    await this.transaction.query(
      `UPDATE queue_item SET state = 'queued', run_id = NULL, reason = NULL, updated_at = clock_timestamp()
       WHERE channel = $1 AND item_id = ANY($2::text[])`,
      [input.channel, input.itemIds],
    );
    return { requeued: rows.length };
  }
}
