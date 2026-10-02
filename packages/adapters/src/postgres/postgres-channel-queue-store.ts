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
  type QueueSummaryQuery,
  type ScanAdmissionSettings,
} from "@crawl-automation/app";
import type { Database, Queryable } from "@crawl-automation/platform";
import type { FamilyFormulaOutcome, FamilyFormulaQuery } from "@crawl-automation/app";
import { recordFamilyOutcome, familyOutcomes } from "./queue-family-queries.js";
import { PostgresFormulaIndex } from "./postgres-formula-index.js";
import type { FormulaQuery } from "@crawl-automation/app";
import { channelQueueStatus, lockChannelQueue } from "./channel-queue-queries.js";
import { PostgresQueueReader } from "./postgres-queue-reader.js";
import { PostgresQueueRequeue } from "./postgres-queue-requeue.js";
import { PostgresQueueSummary } from "./postgres-queue-summary.js";

import { PostgresQueueAdd } from "./postgres-queue-add.js";

/** The shared queue tables (queue_control, link_batch, queue_item, queue_attempt) of every channel. */
export class PostgresChannelQueueStore implements QueueStore {
  constructor(private readonly database: Database) {}

  recordFamilyOutcome(outcome: FamilyFormulaOutcome) {
    return recordFamilyOutcome(this.database, outcome);
  }

  familyOutcomes(query: FamilyFormulaQuery) {
    return familyOutcomes(this.database, query);
  }

  findFamilyFormula(query: FormulaQuery) {
    return new PostgresFormulaIndex(this.database).findKnown(query);
  }

  status(channel: QueueChannel) {
    return channelQueueStatus(this.database, channel);
  }

  items(query: QueueItemsQuery) {
    return new PostgresQueueReader(this.database).items(query);
  }

  summary(query: QueueSummaryQuery) {
    return new PostgresQueueSummary(this.database).summary(query);
  }

  add(input: AddToQueue, discovery?: ScanAdmissionSettings) {
    return this.locked(input.channel, (tx) => new PostgresQueueAdd(tx).add(input, discovery));
  }

  /** Formula requests from Whole Foods use the same Amazon queue and dispatcher as direct product lists. */
  holdAmazonProducts(list: Omit<AddProducts, "channel">): Promise<{ added: number }> {
    return this.add({ ...list, channel: "amazon" });
  }

  /** The brand's source for the formula request, preferring enabled entries; no particular URL is required. */
  async amazonSourceOf(brandId: string): Promise<string | null> {
    const rows = await this.database.query<{ id: string }>(
      `SELECT id FROM brand_source WHERE brand_id = $1 AND channel = 'amazon'
       ORDER BY enabled DESC, created_at, id LIMIT 1`,
      [brandId],
    );
    return rows[0]?.id ?? null;
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

  requeue(input: Requeue) {
    return this.locked(input.channel, (tx) => new PostgresQueueRequeue(tx).requeue(input));
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
