import type { QueueItemsQuery, QueueItemView } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";
import { ItemRow } from "./queue-rows.js";

const SharedItemRow = ItemRow.extend({
  sourceId: z.uuid(),
  updatedAt: z
    .union([z.date(), z.iso.datetime({ offset: true })])
    .transform((value) => (value instanceof Date ? value.toISOString() : value)),
});

/** Shared selection for listing and bounded requeue, including the same stable ordering. */
export class PostgresQueueReader {
  constructor(private readonly database: Queryable) {}

  async items(query: QueueItemsQuery, lock = false): Promise<QueueItemView[]> {
    const rows = await this.database.query(
      `SELECT item_id AS "itemId", batch_id::text AS batch, state, attempt, run_id::text AS "runId",
         listing_id AS "listingId", source_id::text AS "sourceId", updated_at AS "updatedAt",
         NULL AS "lastError", reason, follows_item_id AS "followsItemId"
       FROM queue_item WHERE channel = $1 AND state = $2
         AND ($4::text[] IS NULL OR reason = ANY($4))
         AND ($5::timestamptz IS NULL OR updated_at >= $5)
         AND ($6::timestamptz IS NULL OR created_at >= $6)
         AND ($7::uuid[] IS NULL OR source_id = ANY($7))
         AND ($8::text[] IS NULL OR listing_id = ANY($8))
       ORDER BY updated_at DESC, item_id LIMIT $3${lock ? " FOR UPDATE" : ""}`,
      [
        query.channel,
        query.state,
        query.limit,
        query.reasons ?? null,
        query.updatedSince ?? null,
        query.createdSince ?? null,
        query.sourceIds ?? null,
        query.listingIds ?? null,
      ],
    );
    return rows.map((row) => SharedItemRow.parse(row));
  }
}
