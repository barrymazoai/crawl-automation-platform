import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import { PostgresDeliveryReader } from "./postgres-delivery-reader.js";
import {
  DELIVERY_COLLECTIONS,
  DELIVERY_QUEUE,
  DELIVERY_SCANS,
  DELIVERY_HOLDS,
} from "./delivery-queries.js";
import { deliveryRequest } from "./product.fixture.js";

describe("settled DTC repository selection", () => {
  it("reads the stored source catalog without filtering out disabled sources awaiting redelivery", async () => {
    const catalogs = [
      { sourceId: "source", catalogUrl: "https://sambucolusa.com/collections/shop-all" },
    ];
    const source = {
      sourceId: "source",
      brandId: "brand",
      brandName: "Sambucol",
      channel: "dtc",
      url: catalogs[0]?.catalogUrl,
      enabled: false,
    };
    const query = vi.fn(async () => [source, { ...source, sourceId: "amazon", channel: "amazon" }]);
    const reader = new PostgresDeliveryReader({
      database: { query } as Queryable,
      objects: { read: vi.fn() },
    });
    expect(await reader.catalogs(["source", "amazon"], new AbortController().signal)).toEqual(
      catalogs,
    );
    expect(query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("s.id = ANY($1::uuid[])"),
      [["source", "amazon"]],
    );
    await expect(reader.catalogs(["source"], AbortSignal.abort())).rejects.toThrow();
    expect(query).toHaveBeenCalledOnce();
  });

  it("never reads collected material for Review, pending or unconfirmed completion", async () => {
    const query = vi.fn(async (sql: string) =>
      sql === DELIVERY_QUEUE
        ? [
            { state: "review", run_id: "old-run" },
            { state: "pending", run_id: "pending-run" },
            { state: "completed", settled_at: null, outcome: "running" },
          ]
        : [],
    );
    const objects = { read: vi.fn() };
    const reader = new PostgresDeliveryReader({ database: { query } as Queryable, objects });
    expect(await reader.read(deliveryRequest, new AbortController().signal)).toEqual({
      products: [],
      review: 1,
      pending: 2,
      scans: [],
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      DELIVERY_QUEUE,
      DELIVERY_SCANS,
      DELIVERY_HOLDS,
    ]);
    expect(objects.read).not.toHaveBeenCalled();
  });

  it("keeps completed products with missing material explicit instead of inventing a label", async () => {
    const query = vi.fn(async (sql: string) =>
      sql === DELIVERY_QUEUE
        ? [
            {
              state: "completed",
              run_id: "request",
              settled_at: new Date(),
              outcome: "completed",
              item_id: "item",
              batch_id: "batch",
              source_id: "source",
              listing_id: "listing",
              variant_id: "variant",
            },
          ]
        : [],
    );
    const reader = new PostgresDeliveryReader({
      database: { query } as Queryable,
      objects: { read: vi.fn() },
    });
    const result = await reader.read(deliveryRequest, new AbortController().signal);
    expect(result.products).toMatchObject([
      { sourceId: "source", externalId: "variant", problem: "PRODUCT_DELIVERY.MATERIAL_MISSING" },
    ]);
    expect(query).toHaveBeenCalledWith(DELIVERY_COLLECTIONS, ["request", "source"]);
  });
});
