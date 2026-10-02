import { readFileSync } from "node:fs";
import type { Database, Queryable } from "@crawl-automation/platform";
import type { AddToQueue } from "@crawl-automation/app";
import { expect, it, vi } from "vitest";
import { PostgresChannelQueueStore } from "./postgres-channel-queue-store.js";
import { PostgresBrandScans } from "./postgres-brand-scans.js";

it("keeps the same DTC SKU once per source even when submitted together", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ found: 2 }])
    .mockResolvedValueOnce([{ batch_id: "batch" }])
    .mockResolvedValueOnce([{ added: 2, following: 0, recent: 0 }]);
  const database = {
    transaction: async (work: (tx: Queryable) => Promise<unknown>) => work({ query }),
  } as unknown as Database;
  const product = {
    listingId: "same-sku",
    variantId: null,
    url: "https://shop.example/products/mineral",
  };
  const input: AddToQueue = {
    channel: "dtc",
    batchId: "batch",
    label: "brands",
    products: [
      { ...product, sourceId: "alpha" },
      { ...product, sourceId: "beta" },
      { ...product, sourceId: "alpha" },
    ],
  };
  expect(
    await new PostgresChannelQueueStore(database).add(input, { recentScanSkipHours: 24 }),
  ).toEqual({ added: 2, following: 0, recent: 0 });
  const [sql, values] = query.mock.calls[3] ?? [];
  const rows = JSON.parse(values?.[2] as string);
  expect(rows.map((row: { source_id: string }) => row.source_id)).toEqual(["alpha", "beta"]);
  expect(new Set(rows.map((row: { item_id: string }) => row.item_id)).size).toBe(2);
  expect(sql.match(/\(\$1 <> 'dtc' OR i.source_id = r.source_id\)/g)).toHaveLength(2);
});

it("isolates DTC active leaders by source without rewriting historical outcomes", () => {
  const sql = readFileSync(
    new URL("../../../../database/v3/047_dtc_brand_queue_scope.sql", import.meta.url),
    "utf8",
  );
  expect(sql).toContain("CASE WHEN channel = 'dtc' THEN source_id::text ELSE '' END");
  expect(sql).toContain("NEW.channel <> 'dtc' OR source_id = NEW.source_id");
  expect(sql).toContain("Drain DTC queue items");
  expect(sql).not.toMatch(/UPDATE queue_item|DELETE FROM/);
});

it("filters scan reporting and cancellation by source in SQL, intersecting other selectors", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ cancelled: 1, cancellationRequested: 0 }]);
  const store = new PostgresBrandScans({ query } as unknown as Database);
  await store.list({ channel: "dtc", limit: 10, sourceId: "alpha" });
  expect(query.mock.calls[0]).toEqual([
    expect.stringContaining("($4::uuid IS NULL OR sc.source_id = $4)"),
    ["dtc", null, 10, "alpha"],
  ]);
  await store.cancel({ channel: "dtc", sourceIds: ["alpha"] });
  expect(query.mock.calls[1]).toEqual([
    expect.stringContaining("($5::uuid[] IS NULL OR source_id = ANY($5::uuid[]))"),
    [null, null, "dtc", expect.any(String), ["alpha"]],
  ]);
});
