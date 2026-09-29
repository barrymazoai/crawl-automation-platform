import { createHash } from "node:crypto";
import {
  appErrors,
  type AddProducts,
  type AddToQueue,
  type PauseQueue,
  type QueueChannel,
  type QueueItemsQuery,
  type QueueLimits,
  type QueueStore,
  type Requeue,
} from "@crawl-automation/app";
import type { Database, Queryable } from "@crawl-automation/platform";
import {
  channelQueueItems,
  channelQueueStatus,
  lockChannelQueue,
} from "./channel-queue-queries.js";

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The shared queue tables (queue_control, link_batch, queue_item, queue_attempt) of every channel but Amazon. */
export class PostgresChannelQueueStore implements QueueStore {
  constructor(private readonly database: Database) {}

  status(channel: QueueChannel) {
    return channelQueueStatus(this.database, channel);
  }

  items(query: QueueItemsQuery) {
    return channelQueueItems(this.database, query);
  }

  add(input: AddToQueue): Promise<{ added: number }> {
    if (input.channel === "amazon") {
      throw appErrors.create("RUN.CHANNEL_UNSUPPORTED", { details: { channel: input.channel } });
    }
    return this.locked(input.channel, async (tx) => {
      await assertSourcesOnChannel(tx, input);
      if (!(await insertBatch(tx, input))) {
        return { added: 0 };
      }
      return { added: await insertItems(tx, input) };
    });
  }

  setLimits(limits: QueueLimits): Promise<void> {
    return this.locked(limits.channel, async (tx) => {
      await tx.query(
        `UPDATE queue_control SET ready_limit = $2, running_limit = $3, updated_at = clock_timestamp()
         WHERE channel = $1`,
        [limits.channel, limits.ready, limits.running],
      );
      // A lower ceiling never cancels running work; it only moves unstarted items back.
      await tx.query(
        `UPDATE queue_item SET state = 'queued', updated_at = clock_timestamp() WHERE item_id IN (
           SELECT item_id FROM queue_item WHERE channel = $1 AND state = 'ready'
           ORDER BY created_at, item_id OFFSET $2)`,
        [limits.channel, limits.ready],
      );
    });
  }

  pause(options: PauseQueue): Promise<void> {
    return this.locked(options.channel, async (tx) => {
      await tx.query(
        `UPDATE queue_control SET mode = $2, force_after = CASE WHEN $2 = 'draining' AND $3::int > 0
           THEN clock_timestamp() + make_interval(secs => $3) ELSE NULL END,
         updated_at = clock_timestamp() WHERE channel = $1`,
        [options.channel, options.force ? "stopping" : "draining", options.graceSeconds],
      );
      await tx.query(
        `UPDATE queue_item SET state = 'queued', updated_at = clock_timestamp()
         WHERE channel = $1 AND state = 'ready'`,
        [options.channel],
      );
    });
  }

  resume(channel: QueueChannel): Promise<void> {
    return this.locked(channel, async (tx) => {
      const rows = await tx.query<{ stopping: boolean }>(
        `SELECT mode = 'stopping' AND EXISTS (SELECT 1 FROM queue_item WHERE channel = $1 AND state = 'running')
           AS stopping FROM queue_control WHERE channel = $1`,
        [channel],
      );
      if (rows[0]?.stopping) {
        throw appErrors.create("QUEUE.CLEANUP_PENDING");
      }
      await tx.query(
        `UPDATE queue_control SET mode = 'running', force_after = NULL, updated_at = clock_timestamp()
         WHERE channel = $1`,
        [channel],
      );
    });
  }

  requeue(input: Requeue): Promise<{ requeued: number }> {
    return this.locked(input.channel, async (tx) => {
      const rows = await tx.query<{ state: string }>(
        "SELECT state FROM queue_item WHERE channel = $1 AND item_id = ANY($2::text[]) FOR UPDATE",
        [input.channel, input.itemIds],
      );
      const settled = rows.every((row) => row.state === "completed" || row.state === "review");
      if (rows.length !== new Set(input.itemIds).size || !settled) {
        throw appErrors.create("QUEUE.REQUEUE_NOT_SETTLED");
      }
      await tx.query(
        `UPDATE queue_item SET state = 'queued', run_id = NULL, reason = NULL, updated_at = clock_timestamp()
         WHERE channel = $1 AND item_id = ANY($2::text[])`,
        [input.channel, input.itemIds],
      );
      return { requeued: rows.length };
    });
  }

  private locked<Result>(
    channel: QueueChannel,
    work: (tx: Queryable) => Promise<Result>,
  ): Promise<Result> {
    return this.database.transaction(async (tx) => {
      await lockChannelQueue(tx, channel);
      return work(tx);
    });
  }
}

/** Every product's brand source exists and belongs to this channel, or nothing is added. */
async function assertSourcesOnChannel(tx: Queryable, input: AddProducts): Promise<void> {
  const sourceIds = [...new Set(input.products.map((product) => product.sourceId))];
  const rows = await tx.query<{ found: number }>(
    "SELECT count(*)::int AS found FROM brand_source WHERE id = ANY($1::uuid[]) AND channel = $2",
    [sourceIds, input.channel],
  );
  if (rows[0]?.found !== sourceIds.length) {
    throw appErrors.create("QUEUE.SOURCE_CHANNEL_MISMATCH", {
      details: { channel: input.channel },
    });
  }
}

/** True for a new list; false for the same list added again; a different list under the same ID is refused. */
async function insertBatch(tx: Queryable, input: AddProducts): Promise<boolean> {
  const hash = sha256(input);
  const inserted = await tx.query(
    `INSERT INTO link_batch (batch_id, channel, label, item_count, record_hash) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING RETURNING batch_id`,
    [input.batchId, input.channel, input.label, input.products.length, hash],
  );
  if (inserted.length === 1) {
    return true;
  }
  const saved = await tx.query<{ record_hash: string }>(
    "SELECT record_hash FROM link_batch WHERE batch_id = $1",
    [input.batchId],
  );
  if (saved[0]?.record_hash !== hash) {
    throw appErrors.create("QUEUE.IMPORT_CONFLICT", { details: { batchId: input.batchId } });
  }
  return false;
}

/** One item per product of the list; the same product twice in one list is one item. */
async function insertItems(tx: Queryable, input: AddProducts): Promise<number> {
  const rows = input.products.map((product) => ({
    item_id: sha256([input.channel, input.batchId, product.listingId, product.variantId]),
    source_id: product.sourceId,
    url: product.url,
    listing_id: product.listingId,
    variant_id: product.variantId,
  }));
  const inserted = await tx.query(
    `INSERT INTO queue_item (item_id, channel, batch_id, source_id, url, listing_id, variant_id)
     SELECT r.item_id, $1, $2, r.source_id, r.url, r.listing_id, r.variant_id
     FROM jsonb_to_recordset($3::jsonb)
       AS r(item_id text, source_id uuid, url text, listing_id text, variant_id text)
     ON CONFLICT DO NOTHING RETURNING item_id`,
    [input.channel, input.batchId, JSON.stringify(rows)],
  );
  return inserted.length;
}
