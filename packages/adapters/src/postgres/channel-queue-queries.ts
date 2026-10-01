import type {
  QueueChannel,
  QueueItemsQuery,
  QueueItemView,
  QueueStatus,
} from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { ItemRow, StatusRow } from "./queue-rows.js";

/** The shared queue's lock space; each channel has its own key in it. */
const CHANNEL_QUEUE_LOCK = 73110325;

/** Serializes changes to one channel's queue (the API calls and the dispatcher). */
export async function lockChannelQueue(tx: Queryable, channel: QueueChannel): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [CHANNEL_QUEUE_LOCK, channel]);
}

/** Mode, limits and item counts by state; attention counts running items a forced stop is waiting on. */
export async function channelQueueStatus(
  db: Queryable,
  channel: QueueChannel,
): Promise<QueueStatus> {
  const rows = await db.query(
    `SELECT c.mode, c.ready_limit AS "readyLimit", c.running_limit AS "runningLimit",
       (SELECT coalesce(jsonb_object_agg(state, n), '{}'::jsonb) FROM
          (SELECT state, count(*)::int AS n FROM queue_item WHERE channel = $1 GROUP BY state) s) AS counts,
       (SELECT count(*)::int FROM queue_item i JOIN queue_attempt a ON a.run_id = i.run_id
          WHERE i.channel = $1 AND i.state = 'running' AND a.stop_requested_at IS NOT NULL) AS attention
     FROM queue_control c WHERE c.channel = $1`,
    [channel],
  );
  return { channel, ...StatusRow.parse(rows[0]) };
}

/** Items of one channel in one state, most recently changed first; a Review item carries its failure code. */
export async function channelQueueItems(
  db: Queryable,
  query: QueueItemsQuery,
): Promise<QueueItemView[]> {
  const rows = await db.query(
    `SELECT item_id AS "itemId", batch_id::text AS batch, state, attempt, run_id::text AS "runId",
       listing_id AS "listingId", NULL AS "lastError", reason, follows_item_id AS "followsItemId"
     FROM queue_item WHERE channel = $1 AND state = $2 ORDER BY updated_at DESC LIMIT $3`,
    [query.channel, query.state, query.limit],
  );
  return rows.map((row) => ItemRow.parse(row));
}
