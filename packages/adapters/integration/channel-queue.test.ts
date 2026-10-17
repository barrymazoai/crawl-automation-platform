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
    await dispatch.settle(second, { state: "review", reason: "CAPTURE.NOT_FOUND" });
    const review = await store.items({ channel: "gnc", state: "review", limit: 10 });
    expect(review.map((item) => item.reason)).toEqual(["CAPTURE.NOT_FOUND"]);
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

  it("an item queued again with forceFormula is claimed with it; completing clears it, a Review keeps it", async () => {
    await store.add(
      AddToQueueSchema.parse({
        channel: "swanson",
        batchId: "55555555-5555-4555-8555-555555555555",
        label: "Swanson ON scan",
        products: [
          {
            sourceId: swansonSource,
            url: "https://www.swansonvitamins.com/p/on-1",
            listingId: "ON1",
          },
        ],
      }),
    );
    const swanson = async (): Promise<QueueControl> => {
      const row = (await dispatch.controls()).find((entry) => entry.channel === "swanson");
      if (!row) {
        throw new Error("no swanson control row");
      }
      return row;
    };
    const claimOne = async () => {
      await dispatch.fillReady(await swanson());
      const [claimed] = await dispatch.claim(await swanson());
      if (!claimed) {
        throw new Error("expected the item to be claimed");
      }
      return claimed;
    };
    const first = await claimOne();
    expect(first.forceFormula).toBe(false);
    await dispatch.settle(first, { state: "completed", reason: null });
    const forced = { channel: "swanson" as const, itemIds: [first.itemId], forceFormula: true };
    expect(await store.requeue(forced)).toEqual({ requeued: 1 });
    const fresh = await claimOne();
    expect(fresh).toMatchObject({ itemId: first.itemId, forceFormula: true });
    expect((await dispatch.running("swanson"))[0]?.forceFormula).toBe(true);
    const flag = async () =>
      (
        await database.query<{ force_formula: boolean }>(
          "SELECT force_formula FROM queue_item WHERE item_id = $1",
          [first.itemId],
        )
      )[0]?.force_formula;
    await dispatch.settle(fresh, { state: "review", reason: "LABEL.FORMULA_INCOMPLETE" });
    expect(await flag()).toBe(true);
    await store.requeue(forced);
    await dispatch.settle(await claimOne(), { state: "completed", reason: null });
    expect(await flag()).toBe(false);
  });

  it("a forced item that follows a queued run of the same product forces that run", async () => {
    const swansonList = (batch: string) =>
      AddToQueueSchema.parse({
        channel: "swanson",
        batchId: batch,
        label: "Swanson ON scan",
        products: [
          {
            sourceId: swansonSource,
            url: "https://www.swansonvitamins.com/p/on-2",
            listingId: "ON2",
          },
        ],
      });
    const swanson = async () => {
      const row = (await dispatch.controls()).find((entry) => entry.channel === "swanson");
      if (!row) {
        throw new Error("no swanson control row");
      }
      await dispatch.fillReady(row);
      const [claimed] = await dispatch.claim(row);
      if (!claimed) {
        throw new Error("expected an item to be claimed");
      }
      return claimed;
    };
    await store.add(swansonList("66666666-6666-4666-8666-666666666666"));
    const earlier = await swanson();
    await dispatch.settle(earlier, { state: "completed", reason: null });
    await store.add(swansonList("77777777-7777-4777-8777-777777777777"));
    await store.requeue({ channel: "swanson", itemIds: [earlier.itemId], forceFormula: true });
    const leader = await swanson();
    expect(leader.itemId).not.toBe(earlier.itemId);
    expect(leader.forceFormula).toBe(true);
    await dispatch.settle(leader, { state: "completed", reason: null });
    const rows = await database.query<{ state: string; force_formula: boolean }>(
      "SELECT state, force_formula FROM queue_item WHERE item_id = ANY($1::text[])",
      [[earlier.itemId, leader.itemId]],
    );
    expect(rows).toEqual([
      { state: "completed", force_formula: false },
      { state: "completed", force_formula: false },
    ]);
  });
});
