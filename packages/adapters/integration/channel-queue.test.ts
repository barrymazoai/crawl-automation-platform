import { execFileSync } from "node:child_process";
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

const batchId = "44444444-4444-4444-8444-444444444444";

describe.skipIf(!hasPostgres)("the shared product queue against a real PostgreSQL", () => {
  let postgres: TemporaryPostgres;
  let database: Database;
  let store: PostgresChannelQueueStore;
  let dispatch: PostgresQueueDispatch;
  let gncSource: string;
  let swansonSource: string;

  const list = (products: number, id = batchId) =>
    AddToQueueSchema.parse({
      channel: "gnc",
      batchId: id,
      label: "GNC Optimum Nutrition scan",
      products: Array.from({ length: products }, (_, index) => ({
        sourceId: gncSource,
        url: `https://www.gnc.com/protein/${350_000 + index}.html`,
        listingId: String(350_000 + index),
      })),
    });
  const control = async (): Promise<QueueControl> => {
    const controls = await dispatch.controls();
    const gnc = controls.find((row) => row.channel === "gnc");
    if (!gnc) {
      throw new Error("no gnc control row");
    }
    return gnc;
  };

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    database = postgres.database;
    store = new PostgresChannelQueueStore(database);
    dispatch = new PostgresQueueDispatch(database);
    const brand = await database.query<{ id: string }>(
      "INSERT INTO brand (name) VALUES ('Optimum Nutrition') RETURNING id",
    );
    const source = (channel: string, url: string) =>
      database.query<{ id: string }>(
        "INSERT INTO brand_source (brand_id, channel, url) VALUES ($1, $2, $3) RETURNING id",
        [brand[0]?.id, channel, url],
      );
    gncSource = (await source("gnc", "https://www.gnc.com/brands/optimum-nutrition/"))[0]?.id ?? "";
    swansonSource = (await source("swanson", "https://www.swansonvitamins.com/b/on"))[0]?.id ?? "";
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  it("adds a list once; the same list again adds nothing; another list under its ID is refused", async () => {
    expect(await store.add(list(5))).toEqual({ added: 5 });
    expect(await store.add(list(5))).toEqual({ added: 0 });
    await expect(store.add(list(4))).rejects.toMatchObject({ code: "QUEUE.IMPORT_CONFLICT" });
    const mixed = AddToQueueSchema.parse({
      ...list(1, "55555555-5555-4555-8555-555555555555"),
      products: [{ sourceId: swansonSource, url: "https://www.gnc.com/x/1.html", listingId: "1" }],
    });
    await expect(store.add(mixed)).rejects.toMatchObject({ code: "QUEUE.SOURCE_CHANNEL_MISMATCH" });
    expect((await store.status("gnc")).counts).toEqual({ queued: 5 });
  });

  it("starts nothing while paused, then fills ready and claims within the limits", async () => {
    expect((await control()).mode).toBe("paused");
    await store.resume("gnc");
    await store.setLimits({ channel: "gnc", ready: 3, running: 2 });
    const running = await control();
    await dispatch.fillReady(running);
    const claimed = await dispatch.claim(running);
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((item) => item.runId)).size).toBe(2);
    await dispatch.fillReady(running);
    expect(await dispatch.claim(running)).toHaveLength(0);
    expect((await store.status("gnc")).counts).toEqual({ running: 2, ready: 3 });
  });

  it("settles a run once, keeps its attempt, and requeues only finished items", async () => {
    const [first, second] = await dispatch.running("gnc");
    if (!first || !second) {
      throw new Error("expected two running items");
    }
    await dispatch.settle(first, { state: "completed", reason: null });
    await dispatch.settle(first, { state: "review", reason: "QUEUE.RUN_FAILED" });
    await dispatch.settle(second, { state: "review", reason: "SOURCE.GONE" });
    const review = await store.items({ channel: "gnc", state: "review", limit: 10 });
    expect(review.map((item) => item.reason)).toEqual(["SOURCE.GONE"]);
    await expect(
      store.requeue({
        channel: "gnc",
        itemIds: [first.itemId, (await dispatch.claim(await control()))[0]?.itemId ?? ""],
      }),
    ).rejects.toMatchObject({ code: "QUEUE.REQUEUE_NOT_SETTLED" });
    expect(await store.requeue({ channel: "gnc", itemIds: [second.itemId] })).toEqual({
      requeued: 1,
    });
    const again = await store.items({ channel: "gnc", state: "queued", limit: 10 });
    expect(again.find((item) => item.itemId === second.itemId)).toMatchObject({
      attempt: 1,
      runId: null,
    });
  });

  it("a forced stop blocks resume until nothing runs, then the idle channel is paused", async () => {
    await store.pause({ channel: "gnc", force: true, graceSeconds: 0 });
    expect((await control()).mode).toBe("stopping");
    await expect(store.resume("gnc")).rejects.toMatchObject({ code: "QUEUE.CLEANUP_PENDING" });
    for (const item of await dispatch.running("gnc")) {
      await dispatch.markStopRequested(item);
      await dispatch.settle(item, { state: "review", reason: "QUEUE.RUN_CANCELLED" });
    }
    await dispatch.pauseIfIdle("gnc");
    expect((await control()).mode).toBe("paused");
    expect((await store.status("gnc")).counts.ready).toBeUndefined();
  });
});
