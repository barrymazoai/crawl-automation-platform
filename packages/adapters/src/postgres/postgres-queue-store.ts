import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  appErrors,
  type AddToQueue,
  type PauseQueue,
  type QueueItemsQuery,
  type QueueLimits,
  type QueueStore,
  type Requeue,
} from "@crawl-automation/app";
import type { Database, Queryable } from "@crawl-automation/platform";
import { queueItems, queueStatus } from "./queue-queries.js";

/** The queue runner's advisory lock. A transaction lock on the same key conflicts with its session lock. */
const QUEUE_LOCK = 73110324;

/** One queue item per product; its ID is stable, so importing the same list again adds nothing. */
function itemId(campaignId: string, scope: unknown, entry: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([campaignId, scope, entry]))
    .digest("hex");
}

type AmazonList = Extract<AddToQueue, { channel: "amazon" }>;

/** Amazon's existing queue tables (amazon_queue_*), unchanged; only the Amazon channel reaches this store. */
export class PostgresQueueStore implements QueueStore {
  constructor(private readonly database: Database) {}

  status() {
    return queueStatus(this.database);
  }

  items(query: QueueItemsQuery) {
    return queueItems(this.database, query);
  }

  add(input: AddToQueue): Promise<{ added: number }> {
    if (input.channel !== "amazon") {
      throw appErrors.create("RUN.CHANNEL_UNSUPPORTED", { details: { channel: input.channel } });
    }
    return this.addAmazon(input);
  }

  private addAmazon(input: AmazonList): Promise<{ added: number }> {
    return this.locked(async (tx) => {
      let added = 0;
      for (const batch of input.batches) {
        for (const entry of batch.entries) {
          added += await insertItem(tx, input.campaignId, { ...batch, entries: [entry] });
        }
      }
      return { added };
    });
  }

  setLimits(limits: QueueLimits): Promise<void> {
    return this.locked(async (tx) => {
      await tx.query(
        `UPDATE amazon_queue_control SET ready_limit = $1, running_limit = $2,
         updated_at = clock_timestamp() WHERE singleton`,
        [limits.ready, limits.running],
      );
      // A lower ceiling never cancels running work; it only moves unstarted items back.
      await tx.query(
        `UPDATE amazon_queue_item SET state = 'queued' WHERE item_id IN (SELECT item_id FROM amazon_queue_item
         WHERE state = 'ready' ORDER BY created_at, item_id OFFSET $1)`,
        [limits.ready],
      );
    });
  }

  pause(options: PauseQueue): Promise<void> {
    return this.locked(async (tx) => {
      await tx.query(
        `UPDATE amazon_queue_control SET mode = $1, force_after = CASE WHEN $1 = 'draining' AND $2::int > 0
           THEN clock_timestamp() + make_interval(secs => $2) ELSE NULL END,
         updated_at = clock_timestamp() WHERE singleton`,
        [options.force ? "stopping" : "draining", options.graceSeconds],
      );
      await tx.query(
        "UPDATE amazon_queue_item SET state = 'queued', updated_at = clock_timestamp() WHERE state = 'ready'",
      );
      await tx.query(
        "UPDATE amazon_queue_item SET next_check_at = clock_timestamp() WHERE state = 'running'",
      );
    });
  }

  resume(): Promise<void> {
    return this.locked(async (tx) => {
      if ((await currentMode(tx)) === "stopping" && (await anyRunning(tx))) {
        throw appErrors.create("QUEUE.CLEANUP_PENDING");
      }
      await tx.query(
        `UPDATE amazon_queue_control SET mode = 'running', force_after = NULL,
         updated_at = clock_timestamp() WHERE singleton`,
      );
    });
  }

  requeue(input: Requeue): Promise<{ requeued: number }> {
    return this.locked(async (tx) => {
      const rows = await tx.query<{ state: string }>(
        "SELECT state FROM amazon_queue_item WHERE item_id = ANY($1::text[]) FOR UPDATE",
        [input.itemIds],
      );
      const settled = rows.every((row) => row.state === "completed" || row.state === "review");
      if (rows.length !== new Set(input.itemIds).size || !settled) {
        throw appErrors.create("QUEUE.REQUEUE_NOT_SETTLED");
      }
      await tx.query(
        `UPDATE amazon_queue_item SET state = 'queued', request_id = NULL, last_error = NULL,
         next_check_at = clock_timestamp(), updated_at = clock_timestamp() WHERE item_id = ANY($1::text[])`,
        [input.itemIds],
      );
      return { requeued: rows.length };
    });
  }

  private locked<Result>(work: (tx: Queryable) => Promise<Result>): Promise<Result> {
    return this.database.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [QUEUE_LOCK]);
      return work(tx);
    });
  }
}

async function insertItem(tx: Queryable, campaignId: string, input: AmazonList["batches"][number]) {
  const [entry] = input.entries;
  const id = itemId(campaignId, input.scope, entry?.entry);
  const inserted = await tx.query(
    `INSERT INTO amazon_queue_item (item_id, campaign_id, input) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING item_id`,
    [id, campaignId, JSON.stringify(input)],
  );
  if (inserted.length === 1) {
    return 1;
  }
  const existing = await tx.query<{ input: unknown }>(
    "SELECT input FROM amazon_queue_item WHERE item_id = $1",
    [id],
  );
  if (!isDeepStrictEqual(existing[0]?.input, JSON.parse(JSON.stringify(input)))) {
    throw appErrors.create("QUEUE.IMPORT_CONFLICT", { details: { itemId: id } });
  }
  return 0;
}

/** A drain past its deadline with work still running becomes a forced stop, as the runner does. */
async function currentMode(tx: Queryable): Promise<string> {
  await tx.query(
    `UPDATE amazon_queue_control SET mode = 'stopping', force_after = NULL, updated_at = clock_timestamp()
     WHERE singleton AND mode = 'draining' AND force_after <= clock_timestamp()
       AND EXISTS (SELECT 1 FROM amazon_queue_item WHERE state = 'running')`,
  );
  const rows = await tx.query<{ mode: string }>(
    "SELECT mode FROM amazon_queue_control WHERE singleton",
  );
  return rows[0]?.mode ?? "paused";
}

async function anyRunning(tx: Queryable): Promise<boolean> {
  const rows = await tx.query("SELECT 1 FROM amazon_queue_item WHERE state = 'running' LIMIT 1");
  return rows.length > 0;
}
