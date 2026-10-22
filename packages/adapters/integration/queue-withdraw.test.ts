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

describe.skipIf(!hasPostgres)("queue withdrawal in PostgreSQL", () => {
  let postgres: TemporaryPostgres;
  let db: Database;
  let queue: PostgresChannelQueueStore;
  let dispatch: PostgresQueueDispatch;
  let sourceId: string;

  const add = async (label: string, listingId: string) => {
    const batchId = randomUUID();
    await queue.add(
      AddToQueueSchema.parse({
        channel: "gnc",
        batchId,
        label,
        products: [{ sourceId, url: `https://example.test/p/${listingId}`, listingId }],
      }),
    );
    return batchId;
  };
  const item = async (batchId: string) => {
    const rows = await db.query<{ item_id: string; state: string; run_id: string | null }>(
      "SELECT item_id, state, run_id::text FROM queue_item WHERE batch_id = $1",
      [batchId],
    );
    if (!rows[0]) {
      throw new Error("missing queue item");
    }
    return rows[0];
  };
  const control: QueueControl = {
    channel: "gnc",
    mode: "running",
    readyLimit: 100,
    runningLimit: 100,
  };

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    db = postgres.database;
    queue = new PostgresChannelQueueStore(db);
    dispatch = new PostgresQueueDispatch(db);
    const [brand] = await db.query<{ id: string }>(
      "INSERT INTO brand (name) VALUES ('Withdraw test') RETURNING id",
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

  it("previews without changes, withdraws queued/ready/following, and reports status by batch", async () => {
    const queued = await add("Queued brand", "queued-one");
    const ready = await add("Ready brand", "ready-one");
    const follower = await add("Follower brand", "queued-one");
    await dispatch.fillReady({ ...control, readyLimit: 1 });
    const selection = [queued, ready, follower];
    const preview = await queue.withdraw({ channel: "gnc", batchIds: selection, dryRun: true });
    expect(preview).toMatchObject({
      dryRun: true,
      matched: 3,
      withdrawn: 3,
      skipped: { running: 0, settled: 0, notFound: 0 },
    });
    expect(new Set(preview.byBatch.map((batch) => batch.label))).toEqual(
      new Set(["Queued brand", "Ready brand", "Follower brand"]),
    );
    expect(preview.byBatch.every((batch) => batch.count === 1)).toBe(true);
    expect((await item(follower)).state).toBe("following");
    const result = await queue.withdraw({
      channel: "gnc",
      batchIds: selection,
      dryRun: false,
      reason: "duplicate scan",
    });
    expect(result.withdrawn).toBe(3);
    expect((await queue.status("gnc")).counts).toEqual({ withdrawn: 3 });
    expect(await queue.items({ channel: "gnc", state: "withdrawn", limit: 10 })).toHaveLength(3);
    const saved = await db.query<{ reason: string; withdraw_note: string; withdrawn_at: Date }>(
      "SELECT reason, withdraw_note, withdrawn_at FROM queue_item WHERE batch_id = $1",
      [queued],
    );
    expect(saved[0]).toMatchObject({ reason: "QUEUE.WITHDRAWN", withdraw_note: "duplicate scan" });
    expect(saved[0]?.withdrawn_at).toBeInstanceOf(Date);
    expect(await dispatch.claim(control)).toEqual([]);
  });

  it("promotes an unselected follower when its unstarted leader is withdrawn", async () => {
    const leader = await add("Leader", "shared-one");
    const follower = await add("Other batch", "shared-one");
    expect((await item(follower)).state).toBe("following");
    await queue.withdraw({ channel: "gnc", batchIds: [leader], dryRun: false });
    expect((await item(leader)).state).toBe("withdrawn");
    expect((await item(follower)).state).toBe("queued");
    await dispatch.fillReady(control);
    expect((await dispatch.claim(control)).map((run) => run.itemId)).toContain(
      (await item(follower)).item_id,
    );
  });

  // Two rescans of one brand queue the same product twice: the leader and its followers go in one call.
  it.each([1, 2, 3, 4, 5])(
    "withdraws a leader together with its followers in one call (round %i)",
    async (round) => {
      const listingId = `together-${round}`;
      const batches = [
        await add("First scan", listingId),
        await add("Second scan", listingId),
        await add("Third scan", listingId),
      ];
      const result = await queue.withdraw({ channel: "gnc", batchIds: batches, dryRun: false });
      expect(result.withdrawn).toBe(3);
      for (const batchId of batches) {
        expect((await item(batchId)).state).toBe("withdrawn");
      }
    },
  );

  it("skips claimed and pending attempts, and permits explicit requeue of withdrawn items", async () => {
    const runningBatch = await add("Running", "running-one");
    await dispatch.fillReady(control);
    const [running] = await dispatch.claim(control);
    if (!running) {
      throw new Error("expected claimed run");
    }
    const blocked = await queue.withdraw({
      channel: "gnc",
      itemIds: [running.itemId, "a".repeat(64)],
      dryRun: false,
    });
    expect(blocked).toMatchObject({
      matched: 1,
      withdrawn: 0,
      skipped: { running: 1, settled: 0, notFound: 1 },
    });
    expect((await item(runningBatch)).state).toBe("running");
    await dispatch.settle(running, { state: "pending", reason: "CAPTURE.IN_FLIGHT" });
    const pending = await queue.withdraw({
      channel: "gnc",
      batchIds: [runningBatch],
      dryRun: false,
    });
    expect(pending).toMatchObject({
      withdrawn: 0,
      skipped: { running: 0, settled: 1, notFound: 0 },
    });
    const withdrawn = await add("Requeue", "requeue-one");
    const withdrawnId = (await item(withdrawn)).item_id;
    await queue.withdraw({ channel: "gnc", itemIds: [withdrawnId], dryRun: false });
    expect(await queue.requeue({ channel: "gnc", itemIds: [withdrawnId] })).toEqual({
      requeued: 1,
    });
    expect((await item(withdrawn)).state).toBe("queued");
  });
});
