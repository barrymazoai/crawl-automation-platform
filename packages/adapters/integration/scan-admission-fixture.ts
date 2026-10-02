import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  AddToQueueSchema,
  QueueChannelSchema,
  QueueService,
  type AddToQueue,
  type QueueChannel,
} from "@crawl-automation/app";
import { createLogger, type Database } from "@crawl-automation/platform";
import { PostgresChannelQueueStore } from "../src/postgres/postgres-channel-queue-store.js";
import { PostgresQueueDispatch } from "../src/postgres/postgres-queue-dispatch.js";

const log = createLogger({
  name: "scan-admission",
  destination: new Writable({ write: (_chunk, _enc, done) => done() }),
});

/** Test-only fixtures; admission, dispatch, settlement and explicit requeue use production code. */
export class ScanAdmissionFixture {
  readonly sources = new Map<QueueChannel, string>();
  readonly store: PostgresChannelQueueStore;
  readonly dispatch: PostgresQueueDispatch;
  readonly queue: QueueService;

  constructor(readonly database: Database) {
    this.store = new PostgresChannelQueueStore(database);
    this.dispatch = new PostgresQueueDispatch(database);
    this.queue = this.service();
  }

  service(recentScanSkipHours = 24) {
    return new QueueService({
      channels: this.store,
      amazonHistory: { migrationPreview: async () => ({ pending: 0, alreadyCopied: 0 }) },
      scanAdmission: { recentScanSkipHours },
      log,
    });
  }

  async seed() {
    const brandId = randomUUID();
    await this.database.query("INSERT INTO brand (id, name) VALUES ($1, 'Scan admission test')", [
      brandId,
    ]);
    for (const channel of QueueChannelSchema.options) {
      const sourceId = randomUUID();
      await this.database.query(
        "INSERT INTO brand_source (id, brand_id, channel, url) VALUES ($1, $2, $3, $4)",
        [sourceId, brandId, channel, `https://example.test/brands/${channel}`],
      );
      this.sources.set(channel, sourceId);
    }
  }

  batch(ids = ["one"], channel: QueueChannel = "wholefoods"): AddToQueue {
    return AddToQueueSchema.parse({
      channel,
      batchId: randomUUID(),
      label: "brand scan: fixture",
      products: ids.map((listingId) => ({
        sourceId: this.sources.get(channel),
        listingId,
        url: `https://example.test/products/${listingId}`,
      })),
    });
  }

  async finish(batch: AddToQueue, state: "completed" | "review" | "pending" = "completed") {
    const control = {
      channel: batch.channel,
      mode: "running" as const,
      readyLimit: 20,
      runningLimit: 20,
    };
    await this.dispatch.fillReady(control);
    const started = await this.dispatch.claim(control);
    for (const item of started) {
      await this.dispatch.settle(item, {
        state,
        reason: state === "review" ? "QUEUE.RUN_FAILED" : null,
      });
    }
    return started;
  }

  async age(batch: AddToQueue, hours: number) {
    // Test clock fixture: move the settlement timestamp, never rewrite immutable attempt history.
    await this.database.query(
      "UPDATE queue_item SET updated_at = clock_timestamp() - make_interval(hours => $2) WHERE batch_id = $1",
      [batch.batchId, hours],
    );
  }
}
