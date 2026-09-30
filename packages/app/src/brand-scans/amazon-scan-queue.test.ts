import { describe, expect, it, vi } from "vitest";
import type { CatalogScope } from "@crawl-automation/v3-contracts";
import { AddToQueueSchema, type AddToQueue } from "../queue/queue-model.js";
import { identifyListing, type ListingIdentityResolver } from "../history/listing-identity.js";
import { AmazonBrandScanQueue } from "./amazon-scan-queue.js";
import type { ScanRecord } from "./scan-model.js";

const scan: ScanRecord = {
  scanId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  revisitBatchId: "33333333-3333-4333-8333-333333333333",
  source: {
    sourceId: "44444444-4444-4444-8444-444444444444",
    brandId: "55555555-5555-4555-8555-555555555555",
    brandName: "Herb Pharm",
    channel: "amazon",
    enabled: true,
    url: "https://www.amazon.com/s?rh=p_123%3A383950",
  },
  state: "running",
  result: null,
  requestedAt: "2026-09-30T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
};
const scope: CatalogScope = {
  brandId: scan.source.brandId,
  sourceId: "66666666-6666-4666-8666-666666666666",
  channel: "amazon",
  region: "US",
  rootUrl: "https://www.amazon.com/",
  scopeVersion: "source-revision-1",
};
const products = Array.from({ length: 24 }, (_, index) => {
  const listingId = `B${String(index).padStart(9, "0")}`;
  return { listingId, variantId: null, url: `https://www.amazon.com/dp/${listingId}` };
});
const identities: ListingIdentityResolver = {
  resolve: (page) => ({ site: "amazon.com", url: page.url, externalId: page.listingId }),
};
function fixture(selectedScope = scope) {
  const queue = { add: vi.fn(async (_input: AddToQueue) => ({ added: products.length })) };
  const knownListings = vi.fn(async () => []);
  const bridge = new AmazonBrandScanQueue({
    queue,
    identities,
    knownListings,
    scopeFor: vi.fn(async () => selectedScope),
  });
  return { bridge, queue, knownListings };
}

describe("Amazon scan queue bridge", () => {
  it("uses the existing batch contract, root scope, history identity and stable replay inputs", async () => {
    const { bridge, queue } = fixture();
    await bridge.add(scan, products, scan.scanId);
    await bridge.add(scan, products, scan.scanId);
    expect(queue.add.mock.calls[0]).toEqual(queue.add.mock.calls[1]);
    const input = AddToQueueSchema.parse(queue.add.mock.calls[0]?.[0]);
    if (input.channel !== "amazon") {
      throw new Error("Expected existing Amazon queue input");
    }
    expect(input.campaignId).toBe(scan.scanId);
    expect(input.batches.map((batch) => batch.entries.length)).toEqual([10, 10, 4]);
    expect(new Set(input.batches.map((batch) => batch.requestId)).size).toBe(3);
    expect(input.batches.every((batch) => batch.scope.sourceId === scope.sourceId)).toBe(true);
    const first = input.batches[0]?.entries[0];
    const firstProduct = products[0];
    if (!firstProduct) {
      throw new Error("Expected a product fixture");
    }
    expect(first?.historyListingId).toBe(
      identifyListing(
        {
          channel: "amazon",
          url: firstProduct.url,
          listingId: firstProduct.listingId,
          externalId: firstProduct.listingId,
          sourceKey: scan.scanId,
          dataset: "brand-scan",
        },
        identities,
      ).id,
    );
    expect(first?.entry).not.toHaveProperty("sourceId");
  });

  it("separates revisit campaigns and delegates known-listing queries to the Amazon store", async () => {
    const { bridge, queue, knownListings } = fixture();
    await bridge.knownListings(scan);
    expect(knownListings).toHaveBeenCalledWith(scan);
    await bridge.add(scan, products.slice(0, 1), scan.revisitBatchId);
    expect(queue.add).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: scan.revisitBatchId }),
    );
  });

  it("does not submit an empty list", async () => {
    const { bridge, queue } = fixture();
    expect(await bridge.add(scan, [], scan.scanId)).toEqual({ added: 0 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each([
    { listingId: "not-an-asin", url: "https://www.amazon.com/dp/not-an-asin" },
    { listingId: "B000000001", url: "https://www.amazon.com/dp/B000000002" },
    { listingId: "B000000001", url: "https://other.example/dp/B000000001" },
    { listingId: "B000000001", url: "https://www.amazon.com/dp/B000000001?ref=scan" },
    { listingId: "B000000001", url: "https://www.amazon.com/gp/product/B000000001" },
  ])("refuses a noncanonical or conflicting product: %j", async (product) => {
    const { bridge, queue } = fixture();
    await expect(
      bridge.add(scan, [{ ...product, variantId: null }], scan.scanId),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("refuses duplicate ASINs within a batch and non-null variants", async () => {
    const { bridge, queue } = fixture();
    const product = { listingId: "B000000001", url: "https://www.amazon.com/dp/B000000001" };
    await expect(
      bridge.add(scan, Array(2).fill({ ...product, variantId: null }), scan.scanId),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      bridge.add(scan, [{ ...product, variantId: "variant" }], scan.scanId),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each([
    { ...scope, channel: "gnc" as const },
    { ...scope, brandId: "wrong-brand" },
  ])("refuses a foreign root scope: %j", async (selectedScope) => {
    const { bridge, queue } = fixture(selectedScope);
    await expect(bridge.add(scan, products, scan.scanId)).rejects.toMatchObject({
      code: "QUEUE.SOURCE_CHANNEL_MISMATCH",
    });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
