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

// Owner 2026-10-06 (CRAWLV3-210): a priority source's products start before older products of other sources.
describe.skipIf(!hasPostgres)("queue priority per source against a real PostgreSQL", () => {
  let postgres: TemporaryPostgres;
  let database: Database;
  let store: PostgresChannelQueueStore;
  let dispatch: PostgresQueueDispatch;
  const sources: Record<"old" | "test" | "other", string> = { old: "", test: "", other: "" };

  const list = (source: string, batchId: string, listings: number[]) =>
    AddToQueueSchema.parse({
      channel: "gnc",
      batchId,
      label: "priority",
      products: listings.map((listing) => ({
        sourceId: source,
        url: `https://www.gnc.com/p/${listing}.html`,
        listingId: String(listing),
      })),
    });
  const control = async (): Promise<QueueControl> => {
    const gnc = (await dispatch.controls()).find((row) => row.channel === "gnc");
    if (!gnc) {
      throw new Error("no gnc control row");
    }
    return gnc;
  };
  const sourcesIn = async (state: string) =>
    (
      await database.query<{ source_id: string }>(
        "SELECT source_id::text FROM queue_item WHERE channel = 'gnc' AND state = $1 ORDER BY item_id",
        [state],
      )
    ).map((row) => row.source_id);

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    database = postgres.database;
    store = new PostgresChannelQueueStore(database);
    dispatch = new PostgresQueueDispatch(database);
    const brand = await database.query<{ id: string }>(
      "INSERT INTO brand (name) VALUES ('Priority Brand') RETURNING id",
    );
    for (const [key, channel] of [
      ["old", "gnc"],
      ["test", "gnc"],
      ["other", "swanson"],
    ] as const) {
      const rows = await database.query<{ id: string }>(
        "INSERT INTO brand_source (brand_id, channel, url) VALUES ($1, $2, $3) RETURNING id",
        [brand[0]?.id, channel, `https://example.com/${key}`],
      );
      sources[key] = rows[0]?.id ?? "";
    }
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  it("starts the priority source's newer products first, then restores oldest-first", async () => {
    await store.add(list(sources.old, "11111111-1111-4111-8111-111111111111", [100, 101, 102]));
    await store.add(list(sources.test, "22222222-2222-4222-8222-222222222222", [200, 201]));
    await store.setLimits({ channel: "gnc", ready: 2, running: 1 });
    expect(
      await store.setSourcePriority({ channel: "gnc", sourceIds: [sources.test], priority: 10 }),
    ).toBe(1);
    await dispatch.fillReady(await control());
    expect(await sourcesIn("ready")).toEqual([sources.test, sources.test]);
    const [started] = await dispatch.claim(await control());
    expect(started?.sourceId).toBe(sources.test);
    await store.setSourcePriority({ channel: "gnc", sourceIds: [sources.test], priority: 0 });
    await dispatch.fillReady(await control());
    expect((await sourcesIn("ready")).sort()).toEqual([sources.old, sources.test].sort());
  });

  it("changes nothing when a named source belongs to another channel", async () => {
    expect(
      await store.setSourcePriority({
        channel: "gnc",
        sourceIds: [sources.old, sources.other],
        priority: 50,
      }),
    ).toBe(1);
    const rows = await database.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM queue_source_priority WHERE priority = 50",
    );
    expect(rows[0]?.n).toBe(0);
  });
});
