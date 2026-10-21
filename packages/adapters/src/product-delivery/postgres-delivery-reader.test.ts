import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalHash, mapDeliveryProduct } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { labelCollectedHash } from "@crawl-automation/processing";
import { LabelCollectedProductSchema } from "@crawl-automation/v3-contracts";
import { PostgresDeliveryReader } from "./postgres-delivery-reader.js";
import {
  DELIVERY_COLLECTIONS,
  DELIVERY_HISTORY,
  DELIVERY_QUEUE,
  DELIVERY_SCANS,
  DELIVERY_HOLDS,
} from "./delivery-queries.js";
import { deliveryProduct, deliveryRequest } from "./product.fixture.js";

function readerWithHistory(variantId: string | null, runId = "request") {
  const fixture = deliveryProduct();
  if (!fixture.collection || !fixture.history || !fixture.product) {
    throw new Error("fixture");
  }
  const collection = LabelCollectedProductSchema.parse(
    JSON.parse(
      JSON.stringify(fixture.collection, (key: string, value: unknown) => {
        if (key === "observationId") {
          return "observation-1";
        }
        if (key === "listingId") {
          return "product-1";
        }
        if (key === "variantId") {
          return "variant-1";
        }
        return value;
      }),
    ),
  );
  const bytes = Buffer.from(JSON.stringify({ codec: "dtc-product/2", evidence: fixture.product }));
  const history = {
    ...fixture.history,
    owner: { ...fixture.history.owner, runId },
    capture: { variantId },
    evidence: [
      { objectKey: "projection", sha256: createHash("sha256").update(bytes).digest("hex") },
    ],
  };
  const matches = runId === "request" && (variantId === null || variantId === "variant-1");
  const query = vi.fn(async (sql: string) => {
    if (sql === DELIVERY_QUEUE) {
      return [
        {
          state: "completed",
          run_id: "request",
          settled_at: new Date(),
          outcome: "completed",
          item_id: "item",
          batch_id: "batch",
          source_id: "source",
          listing_id: "product-1",
          variant_id: "variant-1",
        },
      ];
    }
    if (sql === DELIVERY_COLLECTIONS) {
      return [{ operation_id: collection.operationId }];
    }
    if (sql.includes("FROM public.collected_product")) {
      return [
        {
          observation_id: collection.observation.observationId,
          record_hash: labelCollectedHash(collection),
          record: collection,
        },
      ];
    }
    if (sql === DELIVERY_HISTORY) {
      return matches ? [{ record: history, body_hash: canonicalHash(history) }] : [];
    }
    return [];
  });
  return {
    query,
    reader: new PostgresDeliveryReader({
      database: { query } as Queryable,
      objects: { read: vi.fn(async () => bytes) },
    }),
  };
}

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

  it("reads the same-run capture with a null variant for a selected website variant", async () => {
    const { reader, query } = readerWithHistory(null);
    const snapshot = await reader.read(deliveryRequest, new AbortController().signal);
    expect(snapshot.products).toMatchObject([
      {
        externalId: "variant-1",
        collection: { observation: { variantId: "variant-1" } },
        history: { capture: { variantId: null } },
        product: { variantId: "variant-1" },
      },
    ]);
    const product = snapshot.products[0];
    if (!product) {
      throw new Error("fixture");
    }
    expect(mapDeliveryProduct(product, deliveryRequest).item.externalId).toBe("variant-1");
    expect(query).toHaveBeenCalledWith(DELIVERY_HISTORY, [
      "request",
      "source",
      "product-1",
      "variant-1",
    ]);
    for (const clause of [
      "record->'owner'->>'runId'=$1",
      "record->'owner'->>'sourceId'=$2",
      "record->'listing'->>'externalId'=$3",
      "record->'capture'->>'variantId' IS NULL",
      "$4::text) DESC",
    ]) {
      expect(DELIVERY_HISTORY).toContain(clause);
    }
  });

  it.each([
    ["another run", null, "other-run"],
    ["another non-null variant", "variant-2", "request"],
  ] as const)("leaves history missing for %s", async (_case, variantId, runId) => {
    const { reader, query } = readerWithHistory(variantId, runId);
    const snapshot = await reader.read(deliveryRequest, new AbortController().signal);
    const product = snapshot.products[0];
    if (!product) {
      throw new Error("fixture");
    }
    expect(product.history).toBeNull();
    expect(() => mapDeliveryProduct(product, deliveryRequest)).toThrow(
      /no complete retained delivery material/u,
    );
    expect(query).toHaveBeenCalledWith(DELIVERY_HISTORY, [
      "request",
      "source",
      "product-1",
      "variant-1",
    ]);
  });
});
