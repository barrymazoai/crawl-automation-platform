import type { QueueItemsQuery, QueueItemView, QueueStatus } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";

const StatusRow = z.object({
  mode: z.enum(["running", "paused", "draining", "stopping"]),
  readyLimit: z.number(),
  runningLimit: z.number(),
  counts: z.record(z.string(), z.number()),
  attention: z.number(),
});

const ItemRow = z.object({
  itemId: z.string(),
  campaignId: z.string(),
  state: z.enum(["queued", "ready", "running", "review", "completed"]),
  attempt: z.number(),
  requestId: z.string().nullable(),
  asin: z.string().nullable(),
  lastError: z.string().nullable(),
  reason: z.string().nullable(),
});

export async function queueStatus(db: Queryable): Promise<QueueStatus> {
  const rows = await db.query(
    `SELECT c.mode, c.ready_limit AS "readyLimit", c.running_limit AS "runningLimit",
       (SELECT coalesce(jsonb_object_agg(state, n), '{}'::jsonb)
          FROM (SELECT state, count(*)::int AS n FROM amazon_queue_item GROUP BY state) s) AS counts,
       (SELECT count(*)::int FROM amazon_queue_item WHERE state = 'running' AND last_error IS NOT NULL)
         AS attention
     FROM amazon_queue_control c WHERE singleton`,
  );
  return StatusRow.parse(rows[0]);
}

/** Items in one state, most recently changed first; a Review item carries its one-line reason. */
export async function queueItems(db: Queryable, query: QueueItemsQuery): Promise<QueueItemView[]> {
  const rows = await db.query(
    `SELECT i.item_id AS "itemId", i.campaign_id AS "campaignId", i.state, i.attempt,
       i.request_id AS "requestId", i.input->'entries'->0->'entry'->>'listingId' AS asin,
       i.last_error AS "lastError", a.proof->'reason'->>'summary' AS reason
     FROM amazon_queue_item i LEFT JOIN amazon_queue_attempt a ON a.request_id = i.request_id
     WHERE i.state = $1 ORDER BY i.updated_at DESC LIMIT $2`,
    [query.state, query.limit],
  );
  return rows.map((row) => ItemRow.parse(row));
}
