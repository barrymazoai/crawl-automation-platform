import { execFileSync } from "node:child_process";
import { MetricsHistory } from "@crawl-automation/app";
import type { CapturedPage } from "@crawl-automation/channels-core";
import type { Database } from "@crawl-automation/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresChannelQueueStore } from "../src/postgres/postgres-channel-queue-store.js";
import { PostgresHistoryReader } from "../src/postgres/postgres-history-reader.js";
import { PostgresProductHistory } from "../src/postgres/postgres-product-history.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

/** The adapters' identity for these fixtures: the page's host and its product ID. */
const identities = {
  resolve: (page: { url: string; listingId: string; externalId: string | null }) => ({
    site: new URL(page.url).hostname,
    url: page.url,
    externalId: page.externalId ?? page.listingId,
  }),
};

const hasPostgres = (() => {
  try {
    execFileSync("initdb", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

function page(changes: Partial<CapturedPage> = {}): CapturedPage {
  return {
    channel: "wholefoods",
    url: "https://www.wholefoodsmarket.com/grocery/product/nordic-naturals-omega-b002cqu54q",
    listingId: "B002CQU54Q",
    variantId: null,
    externalId: "B002CQU54Q",
    capturedAt: "2026-09-30T02:00:00.000Z",
    commerce: {
      codec: "public-product-commerce/1",
      sku: "B002CQU54Q",
      price: "45.04",
      currency: "USD",
      listPrice: null,
      rating: null,
      reviewCount: null,
      availability: "available",
      context: ["wholefoods-store:10259", "wholefoods-store-label:The Alameda"],
      priceStatus: "observed",
    },
    archive: { objectKey: "v3/wholefoods-html/op-1/original.html", sha256: "c".repeat(64) },
    ...changes,
  };
}

const run = {
  runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  operationId: "op-1",
  brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
};

describe.skipIf(!hasPostgres)("metrics history and Amazon holds against a real PostgreSQL", () => {
  let postgres: TemporaryPostgres;
  let database: Database;
  let history: MetricsHistory;

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    database = postgres.database;
    history = new MetricsHistory(new PostgresProductHistory(database), identities);
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  it("stores one metrics point per capture, with the store, and adds nothing when recorded again", async () => {
    const first = await history.record(page(), run);
    expect(first.inserted).toBe(true);
    expect((await history.record(page(), run)).inserted).toBe(false);
    const points = await database.query<{
      kind: string;
      observed_at: Date;
      record: Record<string, unknown>;
    }>("SELECT kind, observed_at, record FROM product_history_observation WHERE listing_id = $1", [
      first.historyListingId,
    ]);
    expect(points).toHaveLength(1);
    expect(points[0]?.observed_at.toISOString()).toBe("2026-09-30T02:00:00.000Z");
    expect(points[0]?.record).toMatchObject({
      price: "45.04",
      currency: "USD",
      inStock: true,
      source: "v3:wholefoods",
      extras: { store: { id: "10259", label: "The Alameda" } },
    });
  });

  it("a later capture of the same listing adds a second point to the same listing", async () => {
    const later = page({ capturedAt: "2026-10-01T02:00:00.000Z" });
    const next = await history.record(later, { ...run, operationId: "op-2" });
    const counts = await database.query<{ points: number }>(
      "SELECT count(*)::int AS points FROM product_history_observation WHERE listing_id = $1",
      [next.historyListingId],
    );
    expect(counts[0]?.points).toBe(2);
  });

  it("reads the listing's metrics back by channel and product ID, newest first", async () => {
    const reader = new PostgresHistoryReader(database);
    const query = {
      channel: "wholefoods" as const,
      externalId: "B002CQU54Q",
      kind: "metrics" as const,
    };
    const answer = await reader.find({ ...query, limit: 10 });
    expect(answer.listings).toEqual([
      expect.objectContaining({ externalId: "B002CQU54Q", basis: "external-id" }),
    ]);
    expect(answer.points.map((point) => point.observedAt)).toEqual([
      "2026-10-01T02:00:00.000Z",
      "2026-09-30T02:00:00.000Z",
    ]);
    expect(answer.points[0]?.record).toMatchObject({ price: "45.04" });
    expect((await reader.find({ ...query, limit: 1 })).points).toHaveLength(1);
    expect(await reader.find({ ...query, externalId: "B000000000", limit: 10 })).toEqual({
      listings: [],
      points: [],
    });
  });

  it("a different record under the same capture is a conflict, and nothing changes", async () => {
    const shown = page();
    const changed = shown.commerce
      ? page({ commerce: { ...shown.commerce, price: "1.00" } })
      : shown;
    await expect(history.record(changed, run)).rejects.toMatchObject({
      code: "HISTORY.CONTENT_CONFLICT",
    });
  });

  it("holds an Amazon ASIN once in the shared queue, under the brand's Amazon source", async () => {
    const store = new PostgresChannelQueueStore(database);
    const brands = await database.query<{ id: string }>(
      "INSERT INTO brand (name) VALUES ('Nordic Naturals') RETURNING id",
    );
    const brandId = brands[0]?.id ?? "";
    expect(await store.amazonSourceOf(brandId)).toBeNull();
    const sources = await database.query<{ id: string }>(
      `INSERT INTO brand_source (brand_id, channel, url, enabled) VALUES ($1, 'amazon', 'https://www.amazon.com/', true)
       RETURNING id`,
      [brandId],
    );
    const sourceId = sources[0]?.id ?? "";
    expect(await store.amazonSourceOf(brandId)).toBe(sourceId);
    const product = {
      sourceId,
      url: "https://www.amazon.com/dp/B002CQU54Q",
      listingId: "B002CQU54Q",
      variantId: null,
    };
    const list = {
      batchId: "55555555-5555-4555-8555-555555555555",
      label: "hold",
      products: [product],
    };
    expect(await store.holdAmazonProducts(list)).toEqual({ added: 1 });
    expect(await store.holdAmazonProducts(list)).toEqual({ added: 0 });
    const items = await database.query<{ state: string }>(
      "SELECT state FROM queue_item WHERE channel = 'amazon' AND listing_id = 'B002CQU54Q'",
    );
    expect(items).toEqual([{ state: "queued" }]);
  });
});
