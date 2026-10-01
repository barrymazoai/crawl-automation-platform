import { randomUUID } from "node:crypto";
import { AddToQueueSchema, type QueueChannel } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { PostgresChannelQueueStore } from "../src/postgres/postgres-channel-queue-store.js";

export const operatorTime = "2026-10-01T00:00:00.000Z";

/** Test data only; all production operator operations are exercised through repository methods. */
export class QueueOperatorFixture {
  readonly brandId = randomUUID();
  readonly sourceId = randomUUID();
  readonly emptySource = randomUUID();
  readonly unscannedSource = randomUUID();
  readonly otherChannelSource = randomUUID();
  readonly requestId = randomUUID();
  readonly scanId = randomUUID();
  readonly laterScanId = randomUUID();
  readonly revisitBatchId = randomUUID();
  readonly queue: PostgresChannelQueueStore;

  constructor(readonly database: Database) {
    this.queue = new PostgresChannelQueueStore(database);
  }

  async seed() {
    await this.database.query("INSERT INTO brand (id, name) VALUES ($1, 'Operator test brand')", [
      this.brandId,
    ]);
    for (const sourceId of [this.sourceId, this.emptySource, this.unscannedSource]) {
      await this.addSource(sourceId, "gnc");
    }
    await this.addSource(this.otherChannelSource, "swanson");
    await this.database.query("UPDATE brand_source SET enabled = true WHERE id = $1", [
      this.sourceId,
    ]);
    await this.addScan({ scanId: this.scanId, sourceId: this.sourceId, requestId: this.requestId });
    await this.addScan({
      scanId: randomUUID(),
      sourceId: this.emptySource,
      requestId: this.requestId,
    });
    await this.addScan({
      scanId: this.laterScanId,
      sourceId: this.sourceId,
      requestId: randomUUID(),
    });
    await this.database.query(
      "UPDATE brand_scan SET state = 'complete', result = '{}'::jsonb, finished_at = $2 WHERE scan_id = $1",
      [this.scanId, operatorTime],
    );
    await this.seedProducts();
  }

  private async seedProducts() {
    await this.addProducts(this.scanId, [
      "retry-1",
      "retry-2",
      "gone",
      "done",
      "running",
      "queued",
    ]);
    await this.setState({ listingId: "retry-1", state: "review", reason: "QUEUE.RUN_FAILED" });
    await this.setState({ listingId: "retry-2", state: "review", reason: "QUEUE.RUN_FAILED" });
    await this.setState({ listingId: "gone", state: "review", reason: "CAPTURE.NOT_FOUND" });
    await this.setState({ listingId: "done", state: "completed", reason: null });
    await this.setState({ listingId: "running", state: "running", reason: null });
    await this.addProducts(this.laterScanId, ["unrelated", "running"]);
    await this.addProducts(this.revisitBatchId, ["revisit"]);
    await this.database.query(
      "UPDATE queue_item SET created_at = $1, updated_at = $1 WHERE source_id = $2",
      [operatorTime, this.sourceId],
    );
  }

  private async addSource(sourceId: string, channel: QueueChannel) {
    await this.database.query(
      "INSERT INTO brand_source (id, brand_id, channel, url) VALUES ($1, $2, $3, $4)",
      [sourceId, this.brandId, channel, `https://example.test/brands/${sourceId}`],
    );
  }

  private async addScan(input: { scanId: string; sourceId: string; requestId: string }) {
    await this.database.query(
      `INSERT INTO brand_scan (scan_id, source_id, request_id, channel, url, revisit_batch_id, requested_at)
       VALUES ($1, $2, $3, 'gnc', 'https://example.test/brand', $4, $5)`,
      [
        input.scanId,
        input.sourceId,
        input.requestId,
        input.scanId === this.scanId ? this.revisitBatchId : randomUUID(),
        input.scanId === this.laterScanId ? "2026-10-02T00:00:00Z" : operatorTime,
      ],
    );
  }

  private addProducts(batchId: string, listings: string[]) {
    return this.queue.add(
      AddToQueueSchema.parse({
        channel: "gnc",
        batchId,
        label: "operator test",
        products: listings.map((listingId) => ({
          sourceId: this.sourceId,
          listingId,
          url: `https://example.test/products/${listingId}`,
        })),
      }),
    );
  }

  private async setState(input: { listingId: string; state: string; reason: string | null }) {
    const runId = randomUUID();
    await this.database.query(
      `WITH moved AS (UPDATE queue_item SET state = $2, run_id = $3, reason = $4, attempt = 1
         WHERE batch_id = $1 AND listing_id = $5 RETURNING item_id, channel)
       INSERT INTO queue_attempt (run_id, item_id, channel, attempt, outcome, reason, settled_at)
       SELECT $3, item_id, channel, 1, $2, $4,
         CASE WHEN $2 = 'running' THEN NULL ELSE $6::timestamptz END FROM moved`,
      [this.scanId, input.state, runId, input.reason, input.listingId, operatorTime],
    );
  }
}
