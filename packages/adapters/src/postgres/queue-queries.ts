import type { QueueItemsQuery, QueueItemView, QueueStatus } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { ItemRow, StatusRow } from "./queue-rows.js";

export async function queueStatus(db: Queryable): Promise<QueueStatus> {
  const rows = await db.query(
    `SELECT c.mode, c.ready_limit AS "readyLimit", c.running_limit AS "runningLimit",
       (SELECT coalesce(jsonb_object_agg(state, n), '{}'::jsonb)
          FROM (SELECT state, count(*)::int AS n FROM amazon_queue_item GROUP BY state) s) AS counts,
       (SELECT count(*)::int FROM amazon_queue_item WHERE state = 'running' AND last_error IS NOT NULL)
         AS attention
     FROM amazon_queue_control c WHERE singleton`,
  );
  return { channel: "amazon", ...StatusRow.parse(rows[0]) };
}

/** Amazon queue items in one state, most recently changed first; a Review item carries its one-line reason. */
export async function queueItems(db: Queryable, query: QueueItemsQuery): Promise<QueueItemView[]> {
  const rows = await db.query(
    `SELECT i.item_id AS "itemId", i.campaign_id AS batch, i.state, i.attempt,
       i.request_id AS "runId", i.input->'entries'->0->'entry'->>'listingId' AS "listingId",
       i.last_error AS "lastError", a.proof->'reason'->>'summary' AS reason
     FROM amazon_queue_item i LEFT JOIN amazon_queue_attempt a ON a.request_id = i.request_id
     WHERE i.state = $1 ORDER BY i.updated_at DESC LIMIT $2`,
    [query.state, query.limit],
  );
  return rows.map((row) => ItemRow.parse(row));
}
