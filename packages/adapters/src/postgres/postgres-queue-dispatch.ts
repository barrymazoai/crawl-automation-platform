import {
  QueueChannelSchema,
  type DispatchStore,
  type QueueChannel,
  type QueueControl,
  type SettledOutcome,
  type StartedItem,
} from "@crawl-automation/app";
import type { Database, Queryable } from "@crawl-automation/platform";
import { z } from "zod";
import { lockChannelQueue } from "./channel-queue-queries.js";

const ControlRow = z.object({
  channel: QueueChannelSchema,
  mode: z.enum(["running", "paused", "draining", "stopping"]),
  readyLimit: z.number(),
  runningLimit: z.number(),
});

const StartedRow = z.object({
  itemId: z.string(),
  channel: QueueChannelSchema,
  runId: z.string(),
  sourceId: z.string(),
  url: z.string(),
  stopRequested: z.boolean(),
});

const STARTED_COLUMNS = `i.item_id AS "itemId", i.channel, i.run_id::text AS "runId",
  i.source_id::text AS "sourceId", i.url`;

/** The shared queue tables as the dispatcher moves items through them; every change under the channel's lock. */
export class PostgresQueueDispatch implements DispatchStore {
  constructor(private readonly database: Database) {}

  async controls(): Promise<QueueControl[]> {
    // A drain past its deadline with work still running becomes a forced stop.
    await this.database.query(
      `UPDATE queue_control c SET mode = 'stopping', force_after = NULL, updated_at = clock_timestamp()
       WHERE c.mode = 'draining' AND c.force_after <= clock_timestamp()
         AND EXISTS (SELECT 1 FROM queue_item i WHERE i.channel = c.channel AND i.state = 'running')`,
    );
    const rows = await this.database.query(
      `SELECT channel, mode, ready_limit AS "readyLimit", running_limit AS "runningLimit"
       FROM queue_control ORDER BY channel`,
    );
    return rows.map((row) => ControlRow.parse(row));
  }

  async running(channel: QueueChannel): Promise<StartedItem[]> {
    const rows = await this.database.query(
      `SELECT ${STARTED_COLUMNS}, a.stop_requested_at IS NOT NULL AS "stopRequested"
       FROM queue_item i JOIN queue_attempt a ON a.run_id = i.run_id
       WHERE i.channel = $1 AND i.state = 'running' ORDER BY i.updated_at, i.item_id`,
      [channel],
    );
    return rows.map((row) => StartedRow.parse(row));
  }

  fillReady(control: QueueControl): Promise<void> {
    return this.locked(control.channel, async (tx) => {
      await tx.query(
        `UPDATE queue_item SET state = 'ready', updated_at = clock_timestamp() WHERE item_id IN (
           SELECT item_id FROM queue_item WHERE channel = $1 AND state = 'queued' ORDER BY created_at, item_id
           LIMIT GREATEST(0, $2 - (SELECT count(*) FROM queue_item WHERE channel = $1 AND state = 'ready')))`,
        [control.channel, control.readyLimit],
      );
    });
  }

  /** Ready -> running up to the running limit: a new attempt number, a new run ID and its attempt row, at once. */
  claim(control: QueueControl): Promise<StartedItem[]> {
    return this.locked(control.channel, async (tx) => {
      const rows = await tx.query(
        `WITH picked AS (
           SELECT item_id FROM queue_item WHERE channel = $1 AND state = 'ready' ORDER BY created_at, item_id
           LIMIT GREATEST(0, $2 - (SELECT count(*) FROM queue_item WHERE channel = $1 AND state = 'running'))),
         moved AS (
           UPDATE queue_item i SET state = 'running', attempt = i.attempt + 1, run_id = gen_random_uuid(),
             reason = NULL, updated_at = clock_timestamp()
           FROM picked WHERE i.item_id = picked.item_id
           RETURNING i.item_id, i.channel, i.run_id, i.source_id, i.url, i.attempt),
         logged AS (
           INSERT INTO queue_attempt (run_id, item_id, channel, attempt)
           SELECT run_id, item_id, channel, attempt FROM moved)
         SELECT ${STARTED_COLUMNS}, false AS "stopRequested" FROM moved i ORDER BY i.item_id`,
        [control.channel, control.runningLimit],
      );
      return rows.map((row) => StartedRow.parse(row));
    });
  }

  settle(item: StartedItem, outcome: SettledOutcome): Promise<void> {
    return this.locked(item.channel, async (tx) => {
      await tx.query(
        `UPDATE queue_attempt SET outcome = $2, reason = $3, settled_at = clock_timestamp()
         WHERE run_id = $1 AND outcome = 'running'`,
        [item.runId, outcome.state, outcome.reason],
      );
      await tx.query(
        `UPDATE queue_item SET state = $2, reason = $3, updated_at = clock_timestamp()
         WHERE item_id = $4 AND run_id = $1 AND state = 'running'`,
        [item.runId, outcome.state, outcome.reason, item.itemId],
      );
    });
  }

  async markStopRequested(item: StartedItem): Promise<void> {
    await this.database.query(
      `UPDATE queue_attempt SET stop_requested_at = clock_timestamp()
       WHERE run_id = $1 AND outcome = 'running' AND stop_requested_at IS NULL`,
      [item.runId],
    );
  }

  async pauseIfIdle(channel: QueueChannel): Promise<void> {
    await this.database.query(
      `UPDATE queue_control SET mode = 'paused', force_after = NULL, updated_at = clock_timestamp()
       WHERE channel = $1 AND mode IN ('draining', 'stopping')
         AND NOT EXISTS (SELECT 1 FROM queue_item WHERE channel = $1 AND state = 'running')`,
      [channel],
    );
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
