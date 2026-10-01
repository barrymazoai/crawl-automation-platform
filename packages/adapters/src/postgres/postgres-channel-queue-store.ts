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
  type QueueSummaryQuery,
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

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

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

  add(input: AddToQueue): Promise<{ added: number; following?: number }> {
    return this.addList(input);
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

  private addList(input: ProductList): Promise<{ added: number; following?: number }> {
    return this.locked(input.channel, async (tx) => {
      await assertSourcesOnChannel(tx, input);
      if (!(await insertBatch(tx, input))) {
        return { added: 0 };
      }
      return insertItems(tx, input);
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

/** A product list of any channel, as the shared tables hold it. */
type ProductList = Omit<AddProducts, "channel"> & { channel: QueueChannel };

/** Every product's brand source exists and belongs to this channel, or nothing is added. */
async function assertSourcesOnChannel(tx: Queryable, input: ProductList): Promise<void> {
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
async function insertBatch(tx: Queryable, input: ProductList): Promise<boolean> {
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
async function insertItems(tx: Queryable, input: ProductList) {
  const rows = input.products.map((product) => ({
    item_id: sha256([input.channel, input.batchId, product.listingId, product.variantId]),
    source_id: product.sourceId,
    url: product.url,
    listing_id: product.listingId,
    variant_id: product.variantId,
  }));
  const inserted = await tx.query<{ state: string }>(
    `INSERT INTO queue_item (item_id, channel, batch_id, source_id, url, listing_id, variant_id)
     SELECT r.item_id, $1, $2, r.source_id, r.url, r.listing_id, r.variant_id
     FROM jsonb_to_recordset($3::jsonb)
       AS r(item_id text, source_id uuid, url text, listing_id text, variant_id text)
     ON CONFLICT DO NOTHING RETURNING item_id, state`,
    [input.channel, input.batchId, JSON.stringify(rows)],
  );
  const following = inserted.filter((item) => item.state === "following").length;
  return {
    added: inserted.filter((item) => item.state === "queued").length,
    ...(following ? { following } : {}),
  };
}
