import { randomUUID } from "node:crypto";
import { AddToQueueSchema, type QueueControl } from "@crawl-automation/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";
import { PostgresChannelQueueStore } from "../src/postgres/postgres-channel-queue-store.js";
import { PostgresQueueDispatch } from "../src/postgres/postgres-queue-dispatch.js";
import { PostgresBrandScans } from "../src/postgres/postgres-brand-scans.js";

// Main session runs on its authorized PostgreSQL test host; never connects to production.
describe.skipIf(process.env.CRAWLER_TEST_POSTGRES !== "1")("DTC per-brand queue scope", () => {
  let postgres: TemporaryPostgres;
  let queue: PostgresChannelQueueStore;
  let dispatch: PostgresQueueDispatch;
  let alpha: string;
  let beta: string;
  const control: QueueControl = {
    channel: "dtc",
    mode: "running",
    readyLimit: 20,
    runningLimit: 20,
  };
  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    queue = new PostgresChannelQueueStore(postgres.database);
    dispatch = new PostgresQueueDispatch(postgres.database);
    const sources = await postgres.database.query<{ id: string }>(
      `WITH brands AS (INSERT INTO brand (name) VALUES ('DTC Alpha'), ('DTC Beta') RETURNING id, name)
       INSERT INTO brand_source (brand_id, channel, url, enabled)
       SELECT id, 'dtc', 'https://shop.example/collections/' || split_part(name, ' ', 2), true
       FROM brands ORDER BY name RETURNING id`,
    );
    alpha = sources[0]?.id ?? "";
    beta = sources[1]?.id ?? "";
  }, 120_000);
  afterAll(async () => postgres?.stop());

  it("persists two scans and scopes cancellation and reporting to one source", async () => {
    const store = new PostgresBrandScans(postgres.database);
    const sources = await store.sources([alpha, beta]);
    const requestId = randomUUID();
    const scans = await store.request(requestId, sources);
    expect(scans).toHaveLength(2);
    expect(new Set(scans.map((scan) => scan.source.sourceId))).toEqual(new Set([alpha, beta]));
    expect(await store.request(requestId, sources)).toEqual(scans);
    expect(await store.cancel({ sourceIds: [alpha] })).toEqual({
      cancelled: 1,
      cancellationRequested: 0,
    });
    expect(await store.list({ sourceId: alpha, limit: 10 })).toMatchObject([
      { state: "cancelled" },
    ]);
    expect(await store.list({ sourceId: beta, limit: 10 })).toMatchObject([{ state: "queued" }]);
  });

  const batch = (sourceId: string, listingId: string) =>
    AddToQueueSchema.parse({
      channel: "dtc",
      batchId: randomUUID(),
      label: "brand scan",
      products: [
        {
          sourceId,
          url: "https://shop.example/products/mineral",
          listingId,
          variantId: null,
        },
      ],
    });

  it("creates two leaders for one SKU, and followers inherit only their own brand's outcome", async () => {
    const lists = [batch(alpha, "shared"), batch(beta, "shared"), batch(alpha, "shared")];
    const results = await Promise.all(lists.map((list) => queue.add(list)));
    expect(results.reduce((count, result) => count + result.added, 0)).toBe(2);
    expect(results.reduce((count, result) => count + (result.following ?? 0), 0)).toBe(1);
    await dispatch.fillReady(control);
    const leaders = await dispatch.claim(control);
    expect(leaders).toHaveLength(2);
    for (const leader of leaders) {
      await dispatch.settle(
        leader,
        leader.sourceId === alpha
          ? { state: "review", reason: "DTC.BRAND_MISMATCH" }
          : { state: "completed", reason: null },
      );
    }
    const rows = await postgres.database.query<{
      source_id: string;
      state: string;
      reason: string | null;
    }>(
      "SELECT source_id, state, reason FROM queue_item WHERE listing_id = 'shared' ORDER BY source_id",
    );
    expect(rows.filter((row) => row.source_id === alpha)).toHaveLength(2);
    expect(
      rows
        .filter((row) => row.source_id === alpha)
        .every((row) => row.reason === "DTC.BRAND_MISMATCH"),
    ).toBe(true);
    expect(rows.filter((row) => row.source_id === beta)).toEqual([
      { source_id: beta, state: "completed", reason: null },
    ]);
  });

  it("a terminal SKU in A does not suppress B's first scan within the recent window", async () => {
    await queue.add(batch(alpha, "recent"));
    await dispatch.fillReady(control);
    const [leader] = await dispatch.claim(control);
    if (!leader) {
      throw new Error("Expected Alpha leader");
    }
    await dispatch.settle(leader, { state: "completed", reason: null });
    const policy = { recentScanSkipHours: 24 };
    expect(await queue.add(batch(alpha, "recent"), policy)).toEqual({
      added: 0,
      following: 0,
      recent: 1,
    });
    expect(await queue.add(batch(beta, "recent"), policy)).toEqual({
      added: 1,
      following: 0,
      recent: 0,
    });
  });
});
