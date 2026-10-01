import { randomUUID } from "node:crypto";
import { sha256, type Database } from "@crawl-automation/platform";

export interface QueueSeed {
  listing: string;
  state: "queued" | "ready" | "running" | "review" | "completed";
  createdAt?: string;
}

/** Cross-batch requests, each with its real attempt history when execution has started. */
export async function seedMigrationQueue(database: Database, seeds: QueueSeed[]) {
  const [brand] = await database.query<{ id: string }>(
    "INSERT INTO brand (name) VALUES ('migration fixture') RETURNING id",
  );
  const [source] = await database.query<{ id: string }>(
    `INSERT INTO brand_source (brand_id, channel, url)
     VALUES ($1, 'amazon', 'https://www.amazon.com/') RETURNING id`,
    [brand?.id],
  );
  for (const [index, seed] of seeds.entries()) {
    await seedQueueItem(database, { ...seed, index, sourceId: source?.id });
  }
  await database.query(`INSERT INTO queue_attempt
    (run_id, item_id, channel, attempt, outcome, settled_at)
    SELECT run_id, item_id, channel, attempt, state,
      CASE WHEN state = 'running' THEN NULL ELSE clock_timestamp() END
    FROM queue_item WHERE run_id IS NOT NULL`);
}

async function seedQueueItem(
  database: Database,
  seed: QueueSeed & { index: number; sourceId: string | undefined },
) {
  const batchId = randomUUID();
  const itemId = sha256(Buffer.from(`${seed.listing}/${seed.index}`));
  const started = !["queued", "ready"].includes(seed.state);
  await database.query(
    `INSERT INTO link_batch (batch_id, channel, label, item_count, record_hash)
     VALUES ($1, 'amazon', 'migration fixture', 1, $2)`,
    [batchId, itemId],
  );
  await database.query(
    `INSERT INTO queue_item
      (item_id, channel, batch_id, source_id, url, listing_id, state, attempt, run_id, created_at)
     VALUES ($1, 'amazon', $2, $3, 'https://www.amazon.com/dp/' || $4, $4, $5, $6, $7, $8)`,
    [
      itemId,
      batchId,
      seed.sourceId,
      seed.listing,
      seed.state,
      started ? 1 : 0,
      started ? randomUUID() : null,
      seed.createdAt ?? "2026-09-01T00:00:00Z",
    ],
  );
}

export async function seedHistoricCapture(database: Database) {
  const original = {
    channel: "amazon",
    capture: { listingId: "B000000001", variantId: null },
    capturedAt: "2026-09-01T00:00:00Z",
  };
  for (const operationId of ["missing-owner", "reused-original"]) {
    await database.query(
      `INSERT INTO html_capture
        (operation_id, channel, listing_id, request, state, captured_at, original)
       VALUES ($1, 'amazon', 'B000000001', $2, 'done', $3, $4)`,
      [
        operationId,
        { ...original, capture: { ...original.capture, operationId } },
        original.capturedAt,
        operationId === "missing-owner"
          ? original
          : {
              ...original,
              capture: { ...original.capture, operationId: "original-owner" },
            },
      ],
    );
  }
}
