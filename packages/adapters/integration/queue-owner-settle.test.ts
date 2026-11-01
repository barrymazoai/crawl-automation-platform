import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AddToQueueSchema, type QueueControl } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresChannelQueueStore } from "../src/postgres/postgres-channel-queue-store.js";
import { PostgresQueueDispatch } from "../src/postgres/postgres-queue-dispatch.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

const hasPostgres = (() => {
  try {
    execFileSync("initdb", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPostgres)("owner settlement of Review items in PostgreSQL", () => {
  let postgres: TemporaryPostgres;
  let db: Database;
  let queue: PostgresChannelQueueStore;
  let dispatch: PostgresQueueDispatch;
  let sourceId: string;
  const control: QueueControl = {
    channel: "gnc",
    mode: "running",
    readyLimit: 100,
    runningLimit: 100,
  };
  const note = "Prolon fasting kits are not supplements";

  /** Queues one product, runs it and settles the run with the given outcome; returns its item ID. */
  const settled = async (
    listingId: string,
    state: "review" | "completed",
    reason: string | null,
  ) => {
    const batchId = randomUUID();
    await queue.add(
      AddToQueueSchema.parse({
        channel: "gnc",
        batchId,
        label: listingId,
        products: [{ sourceId, url: `https://example.test/p/${listingId}`, listingId }],
      }),
    );
    await dispatch.fillReady(control);
    const run = (await dispatch.claim(control)).find((started) => started.url.endsWith(listingId));
    if (!run) {
      throw new Error("expected claimed run");
    }
    await dispatch.settle(run, { state, reason });
    return run.itemId;
  };
  const row = async (itemId: string) => {
    const rows = await db.query<{
      state: string;
      reason: string | null;
      run_id: string | null;
      owner_note: string | null;
      owner_settled_at: Date | null;
    }>(
      "SELECT state, reason, run_id::text, owner_note, owner_settled_at FROM queue_item WHERE item_id = $1",
      [itemId],
    );
    if (!rows[0]) {
      throw new Error("missing queue item");
    }
    return rows[0];
  };

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    db = postgres.database;
    queue = new PostgresChannelQueueStore(db);
    dispatch = new PostgresQueueDispatch(db);
    const [brand] = await db.query<{ id: string }>(
      "INSERT INTO brand (name) VALUES ('Owner settle test') RETURNING id",
    );
    const [source] = await db.query<{ id: string }>(
      "INSERT INTO brand_source (brand_id, channel, url) VALUES ($1, 'gnc', 'https://example.test') RETURNING id",
      [brand?.id],
    );
    sourceId = source?.id ?? "";
  }, 120_000);
  afterAll(async () => {
    await postgres?.stop();
  });

  it("previews without changes, then settles only Review items and keeps their run and attempt", async () => {
    const review = await settled("kit-one", "review", "TEXT.LABEL_CORE_MISSING");
    const done = await settled("collected-one", "completed", null);
    const input = {
      channel: "gnc" as const,
      itemIds: [review, done, "a".repeat(64)],
      reason: "PRODUCT.NOT_SUPPLEMENT" as const,
      note,
    };
    expect(await queue.settleReview({ ...input, dryRun: true })).toEqual({
      dryRun: true,
      matched: 2,
      settled: 1,
      skipped: { notReview: 1, collected: 0, notFound: 1 },
    });
    expect((await row(review)).state).toBe("review");
    const result = await queue.settleReview({ ...input, dryRun: false });
    expect(result.settled).toBe(1);
    const after = await row(review);
    expect(after).toMatchObject({
      state: "completed",
      reason: "PRODUCT.NOT_SUPPLEMENT",
      owner_note: note,
    });
    expect(after.run_id).not.toBeNull();
    expect(after.owner_settled_at).toBeInstanceOf(Date);
    const attempts = await db.query<{ outcome: string; reason: string | null }>(
      "SELECT outcome, reason FROM queue_attempt WHERE item_id = $1",
      [review],
    );
    expect(attempts).toEqual([{ outcome: "review", reason: "TEXT.LABEL_CORE_MISSING" }]);
    expect((await row(done)).reason).toBeNull();
    const [view] = await queue.items({
      channel: "gnc",
      state: "completed",
      listingIds: ["kit-one"],
      limit: 1,
    });
    expect(view).toMatchObject({ ownerNote: note, reason: "PRODUCT.NOT_SUPPLEMENT" });
  });

  it("keeps a Review whose listing already has a collected product", async () => {
    await settled("shared-one", "completed", null);
    const review = await settled("shared-one", "review", "TEXT.LABEL_CORE_MISSING");
    const result = await queue.settleReview({
      channel: "gnc",
      itemIds: [review],
      reason: "PRODUCT.NOT_SUPPLEMENT",
      note,
      dryRun: false,
    });
    expect(result).toMatchObject({
      settled: 0,
      skipped: { notReview: 0, collected: 1, notFound: 0 },
    });
    expect((await row(review)).state).toBe("review");
  });

  it("lets a settled item be queued again, keeping the owner's note", async () => {
    const review = await settled("again-one", "review", "TEXT.LABEL_CORE_MISSING");
    await queue.settleReview({
      channel: "gnc",
      itemIds: [review],
      reason: "PRODUCT.NOT_SUPPLEMENT",
      note,
      dryRun: false,
    });
    expect(await queue.requeue({ channel: "gnc", itemIds: [review] })).toEqual({ requeued: 1 });
    expect(await row(review)).toMatchObject({ state: "queued", owner_note: note });
  });
});
