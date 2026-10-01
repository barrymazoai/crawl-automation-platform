import { randomUUID } from "node:crypto";
import { AddToQueueSchema, type QueueControl } from "@crawl-automation/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";
import { PostgresChannelQueueStore } from "../src/postgres/postgres-channel-queue-store.js";
import { PostgresQueueDispatch } from "../src/postgres/postgres-queue-dispatch.js";

// Explicit opt-in only, on the authorized test host. Never connects to production PostgreSQL.
describe.skipIf(process.env.CRAWLER_TEST_POSTGRES !== "1")(
  "queue cross-batch claims in PostgreSQL",
  () => {
    let postgres: TemporaryPostgres;
    let queue: PostgresChannelQueueStore;
    let dispatch: PostgresQueueDispatch;
    let sourceId: string;
    const control: QueueControl = {
      channel: "wholefoods",
      mode: "running",
      readyLimit: 20,
      runningLimit: 20,
    };
    beforeAll(async () => {
      postgres = await startTemporaryPostgres();
      queue = new PostgresChannelQueueStore(postgres.database);
      dispatch = new PostgresQueueDispatch(postgres.database);
      const brands = await postgres.database.query<{ id: string }>(
        "INSERT INTO brand (name) VALUES ('WF queue fixture') RETURNING id",
      );
      const sources = await postgres.database.query<{ id: string }>(
        "INSERT INTO brand_source (brand_id, channel, url) VALUES ($1, 'wholefoods', 'https://example.test') RETURNING id",
        [brands[0]?.id],
      );
      sourceId = sources[0]?.id ?? "";
    }, 120_000);
    afterAll(async () => postgres?.stop());
    const list = (variantId: string | null = null) =>
      AddToQueueSchema.parse({
        channel: "wholefoods",
        batchId: randomUUID(),
        label: "test",
        products: [
          { sourceId, url: "https://example.test/product", listingId: "B0096M5PBW", variantId },
        ],
      });

    it("serializes simultaneous batches, settles followers once, and allows owner requeue immediately", async () => {
      const batches = [list(), list(), list()];
      const results = await Promise.all(batches.map((batch) => queue.add(batch)));
      expect(results.reduce((sum, result) => sum + result.added, 0)).toBe(1);
      expect(results.reduce((sum, result) => sum + (result.following ?? 0), 0)).toBe(2);
      await dispatch.fillReady(control);
      const [leader, ...others] = await dispatch.claim(control);
      if (!leader) {
        throw new Error("expected a leader");
      }
      expect(others).toEqual([]);
      expect(await queue.add(list())).toEqual({ added: 0, following: 1 });
      expect(
        (await queue.items({ channel: "wholefoods", state: "following", limit: 20 })).every(
          (item) => item.followsItemId === leader.itemId && item.attempt === 0,
        ),
      ).toBe(true);
      await dispatch.settle(leader, { state: "completed", reason: null });
      const complete = await queue.items({ channel: "wholefoods", state: "completed", limit: 20 });
      expect(complete).toHaveLength(4);
      expect(new Set(complete.map((item) => item.runId))).toEqual(new Set([leader.runId]));
      expect(
        await queue.requeue({
          channel: "wholefoods",
          itemIds: complete.map((item) => item.itemId),
        }),
      ).toEqual({ requeued: 4 });
      expect((await queue.status("wholefoods")).counts).toMatchObject({ queued: 1, following: 3 });
      await dispatch.fillReady(control);
      const [next] = await dispatch.claim(control);
      if (!next) {
        throw new Error("expected owner requeue");
      }
      expect(next.runId).not.toBe(leader.runId);
      await dispatch.settle(next, { state: "review", reason: "QUEUE.RUN_FAILED" });
      expect((await queue.status("wholefoods")).counts).toEqual({ review: 4 });
      const attempts = await postgres.database.query("SELECT * FROM queue_attempt");
      expect(attempts).toHaveLength(2);
    });

    it("does not coalesce distinct variants", async () => {
      expect(await queue.add(list("small"))).toEqual({ added: 1 });
      expect(await queue.add(list("large"))).toEqual({ added: 1 });
      expect(await queue.add(list("small"))).toEqual({ added: 0, following: 1 });
    });
  },
);
