import { execFileSync } from "node:child_process";
import { AddToQueueSchema, type ScanResult } from "@crawl-automation/app";
import { hashString } from "@crawl-automation/processing";
import type { Database } from "@crawl-automation/platform";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresBrandScans } from "../src/postgres/postgres-brand-scans.js";
import { PostgresBrandSourceImport } from "../src/postgres/postgres-brand-source-import.js";
import { PostgresChannelQueueStore } from "../src/postgres/postgres-channel-queue-store.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

const hasPostgres = (() => {
  try {
    execFileSync("initdb", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

const requestId = "66666666-6666-4666-8666-666666666666";
const earlierList = "77777777-7777-4777-8777-777777777777";
const observedList = "abababab-abab-4bab-8bab-abababababab";
const collectedFixture = JSON.parse(
  readFileSync(new URL("../src/postgres/fixtures/collected-product.json", import.meta.url), "utf8"),
) as Record<string, unknown> & { observation: Record<string, unknown> };

const result: ScanResult = {
  state: "complete",
  pages: 1,
  products: 1,
  families: 0,
  unresolvedFamilies: 0,
  statedTotal: 1,
  full: true,
  newListings: 1,
  knownListings: 0,
  missing: 1,
  queued: 1,
  credits: 10,
  code: null,
};

describe.skipIf(!hasPostgres)("brand scans against a real PostgreSQL", () => {
  let postgres: TemporaryPostgres;
  let database: Database;
  let scans: PostgresBrandScans;
  let sourceId: string;

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    database = postgres.database;
    scans = new PostgresBrandScans(database);
    const imports = new PostgresBrandSourceImport(database);
    await database.query("INSERT INTO brand (name) VALUES ('Nordic Naturals')");
    const [brand] = await imports.brandNames();
    const url = "https://www.gnc.com/brands/nordic-naturals/";
    expect(
      await imports.addDisabledSources([{ brandId: brand?.brandId ?? "", channel: "gnc", url }]),
    ).toEqual({
      created: 1,
      existing: 0,
    });
    expect(
      await imports.addDisabledSources([{ brandId: brand?.brandId ?? "", channel: "gnc", url }]),
    ).toEqual({
      created: 0,
      existing: 1,
    });
    const rows = await database.query<{ id: string; enabled: boolean }>(
      "SELECT id::text AS id, enabled FROM brand_source",
    );
    expect(rows).toEqual([expect.objectContaining({ enabled: false })]);
    sourceId = rows[0]?.id ?? "";
    await database.query("UPDATE brand_source SET enabled = true WHERE id = $1", [sourceId]);
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  it("starts each source's scan once per request, claims it, and keeps the finished result unchangeable", async () => {
    const [source] = await scans.enabledSources("gnc");
    expect(source).toMatchObject({ brandName: "Nordic Naturals", enabled: true });
    const first = await scans.request(requestId, source ? [source] : []);
    const again = await scans.request(requestId, source ? [source] : []);
    expect(again.map((scan) => scan.scanId)).toEqual(first.map((scan) => scan.scanId));
    const [claimed] = await scans.claim(4, 60_000);
    expect(claimed).toMatchObject({ scanId: first[0]?.scanId, state: "running" });
    expect(await scans.claim(4, 60_000)).toEqual([]);
    await scans.finish(claimed?.scanId ?? "", result);
    await scans.finish(claimed?.scanId ?? "", {
      ...result,
      state: "review",
      code: "BRAND_SCAN.URL",
    });
    expect(await scans.list({ channel: "gnc", limit: 10 })).toEqual([
      expect.objectContaining({ state: "complete", result }),
    ]);
  });

  it("knows the source's listings from earlier lists, not from the scan's own list", async () => {
    const queue = new PostgresChannelQueueStore(database);
    const [scan] = await scans.list({ channel: "gnc", limit: 1 });
    const product = (listingId: string) => ({
      sourceId,
      url: `https://www.gnc.com/omega/${listingId}.html`,
      listingId,
    });
    const add = (batchId: string, ids: string[]) =>
      queue.add(
        AddToQueueSchema.parse({
          channel: "gnc",
          batchId,
          label: "test",
          products: ids.map(product),
        }),
      );
    await add(earlierList, ["877080", "877081"]);
    await add(scan?.scanId ?? "", ["877082"]);
    const [source] = await scans.sources([sourceId]);
    if (!scan || !source) {
      throw new Error("the scan and its source exist");
    }
    const known = await scans.knownListings(source, scan.scanId);
    expect(known.map((item) => item.listingId)).toEqual(["877080", "877081"]);
  });

  it("reads only variants actually collected by earlier base-address attempts", async () => {
    const [scan] = await scans.list({ channel: "gnc", limit: 1 });
    const [source] = await scans.sources([sourceId]);
    if (!scan || !source) {
      throw new Error("scan source missing");
    }
    const queue = new PostgresChannelQueueStore(database);
    await queue.add(
      AddToQueueSchema.parse({
        channel: "gnc",
        batchId: observedList,
        label: "base observations",
        products: [
          { sourceId, url: "https://www.gnc.com/products/base", listingId: "base" },
          { sourceId, url: "https://www.gnc.com/products/uncaptured", listingId: "uncaptured" },
          {
            sourceId,
            url: "https://www.gnc.com/products/base?variant=other",
            listingId: "base",
            variantId: "other",
          },
        ],
      }),
    );
    const rows = await database.query<{ item_id: string; variant_id: string | null }>(
      "SELECT item_id, variant_id FROM queue_item WHERE batch_id = $1::uuid AND listing_id = 'base'",
      [observedList],
    );
    for (const item of rows) {
      const base = item.variant_id === null;
      const runId = base
        ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        : "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      await database.query(
        "UPDATE queue_item SET state = 'running', attempt = 1, run_id = $2::uuid WHERE item_id = $1",
        [item.item_id, runId],
      );
      await database.query(
        "INSERT INTO queue_attempt (run_id, item_id, channel, attempt) VALUES ($1::uuid, $2, 'gnc', 1)",
        [runId, item.item_id],
      );
      const operationId = `base-observed-${base ? "base" : "variant"}`;
      const observationId = `base-observation-${base ? "base" : "variant"}`;
      const record = {
        ...collectedFixture,
        operationId,
        observation: {
          ...collectedFixture.observation,
          requestId: runId,
          observationId,
          sourceId,
          listingId: "base",
          variantId: item.variant_id === null ? "captured" : "other",
        },
      };
      await database.query(
        `INSERT INTO collected_product (operation_id, observation_id, record_hash, record)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [operationId, observationId, hashString(JSON.stringify(record)), JSON.stringify(record)],
      );
    }
    expect(await scans.observedBaseVariants(source, scan.scanId, ["base", "uncaptured"])).toEqual(
      new Map([["base", new Set(["captured"])]]),
    );
    expect(await scans.observedBaseVariants(source, scan.scanId, [])).toEqual(new Map());
  });

  it("answers one scan, and counts its revisits: listed, seen and not seen yet", async () => {
    const [scan] = await scans.list({ channel: "gnc", limit: 1 });
    if (!scan) {
      throw new Error("the scan exists");
    }
    expect(await scans.get(scan.scanId)).toEqual(scan);
    expect(await scans.get("88888888-8888-4888-8888-888888888888")).toBeNull();
    expect(await scans.revisits(scan.revisitBatchId)).toEqual({
      requested: 0,
      live: 0,
      unlisted: {},
      pending: 0,
    });
    await new PostgresChannelQueueStore(database).add(
      AddToQueueSchema.parse({
        channel: "gnc",
        batchId: scan.revisitBatchId,
        label: "revisit",
        products: [{ sourceId, url: "https://www.gnc.com/omega/877083.html", listingId: "877083" }],
      }),
    );
    expect(await scans.revisits(scan.revisitBatchId)).toMatchObject({ requested: 1, pending: 1 });
    // The revisit ran: its product run saw the page gone.
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await database.query(
      `WITH moved AS (UPDATE queue_item SET state = 'running', attempt = 1, run_id = $2::uuid
         WHERE batch_id = $1::uuid RETURNING item_id, channel)
       INSERT INTO queue_attempt (run_id, item_id, channel, attempt) SELECT $2::uuid, item_id, channel, 1 FROM moved`,
      [scan.revisitBatchId, runId],
    );
    await database.query(
      `INSERT INTO listing_state_observation
         (observation_id, channel, listing_id, variant_id, run_id, state, reason, evidence, source, captured_at)
       VALUES ($1, 'gnc', '877083', NULL, $2::uuid, 'unlisted', 'not_found', '{"httpStatus": "404"}', 'test', now())`,
      ["b".repeat(64), runId],
    );
    expect(await scans.revisits(scan.revisitBatchId)).toEqual({
      requested: 1,
      live: 0,
      unlisted: { not_found: 1 },
      pending: 0,
    });
  });

  it("reads a result finished before the new and known counts existed", async () => {
    const [scan] = await scans.list({ channel: "gnc", limit: 1 });
    const old = { ...result } as Partial<ScanResult>;
    delete old.newListings;
    delete old.knownListings;
    await database.query(
      `INSERT INTO brand_scan (request_id, source_id, channel, url, state, result, finished_at)
       VALUES ('99999999-9999-4999-8999-999999999999', $1, 'gnc', $2, 'complete', $3::jsonb, now())`,
      [sourceId, scan?.source.url, JSON.stringify(old)],
    );
    const [latest] = await scans.list({ channel: "gnc", limit: 1 });
    expect(latest?.result).toMatchObject({ newListings: null, knownListings: null });
  });
  it("cancels queued scans atomically and never reclaims or overwrites their terminal rows", async () => {
    const sources = await scans.sources([sourceId]);
    const requestId = "12121212-1212-4212-8212-121212121212";
    const [scan] = await scans.request(requestId, sources);
    if (!scan) {
      throw new Error("scan fixture missing");
    }
    expect(await scans.cancel({ requestId, channel: "wholefoods" })).toEqual({
      cancelled: 0,
      cancellationRequested: 0,
    });
    expect(await scans.cancel({ scanIds: [scan.scanId], requestId, channel: "gnc" })).toEqual({
      cancelled: 1,
      cancellationRequested: 0,
    });
    expect(await scans.cancel({ requestId })).toEqual({ cancelled: 0, cancellationRequested: 0 });
    expect(await scans.get(scan.scanId)).toMatchObject({
      state: "cancelled",
      result: { state: "cancelled", code: "BRAND_SCAN.CANCELLED", full: false, queued: 0 },
    });
    expect(await scans.claim(10, 0)).toEqual([]);
    await scans.finish(scan.scanId, result);
    expect((await scans.get(scan.scanId))?.state).toBe("cancelled");
  });

  it("recovers a stale cancellation request and lets cancellation win a racing completion", async () => {
    const sources = await scans.sources([sourceId]);
    const requestId = "13131313-1313-4313-8313-131313131313";
    const [scan] = await scans.request(requestId, sources);
    if (!scan) {
      throw new Error("scan fixture missing");
    }
    await scans.claim(1, 0);
    expect(await scans.cancel({ requestId })).toEqual({ cancelled: 0, cancellationRequested: 1 });
    expect((await scans.get(scan.scanId))?.state).toBe("running");
    expect(await scans.isCancellationRequested(scan.scanId)).toBe(true);
    expect(await scans.cancel({ requestId })).toEqual({ cancelled: 0, cancellationRequested: 0 });
    expect(await scans.claim(1, 0)).toMatchObject([{ scanId: scan.scanId, state: "running" }]);
    // A runner's completion may already be in flight when the cancellation is requested.
    await scans.finish(scan.scanId, { ...result, queued: 3 });
    expect((await scans.get(scan.scanId))?.result).toMatchObject({
      state: "cancelled",
      full: false,
      queued: 3,
      code: "BRAND_SCAN.CANCELLED",
    });
    expect(await scans.claim(10, 0)).toEqual([]);
  });
});
