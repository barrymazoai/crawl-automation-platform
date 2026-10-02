import { describe, expect, it, vi } from "vitest";
import { AddToQueueSchema, type AddToQueue } from "../queue/queue-model.js";
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
const products = Array.from({ length: 24 }, (_, index) => {
  const listingId = `B${String(index).padStart(9, "0")}`;
  return { listingId, variantId: null, url: `https://www.amazon.com/dp/${listingId}` };
});
function fixture() {
  const queue = {
    add: vi.fn(async (_input: AddToQueue) => ({ added: products.length })),
    addScanDiscovery: vi.fn(async (_input: AddToQueue) => ({
      added: products.length,
      following: 0,
      recent: 0,
    })),
  };
  const knownListings = vi.fn(async () => []);
  const bridge = new AmazonBrandScanQueue({ queue, knownListings });
  return { bridge, queue, knownListings };
}

describe("Amazon scan queue bridge", () => {
  it("queues all scan URLs under a stable shared batch and the scan source", async () => {
    const { bridge, queue } = fixture();
    expect(await bridge.add(scan, products, scan.scanId)).toEqual({
      added: 24,
      following: 0,
      recent: 0,
    });
    await bridge.add(scan, products, scan.scanId);
    expect(queue.addScanDiscovery.mock.calls[0]).toEqual(queue.addScanDiscovery.mock.calls[1]);
    const input = AddToQueueSchema.parse(queue.addScanDiscovery.mock.calls[0]?.[0]);
    expect(input).toEqual({
      channel: "amazon",
      batchId: scan.scanId,
      label: "brand scan: Herb Pharm",
      products: products.map((product) => ({ ...product, sourceId: scan.source.sourceId })),
    });
  });

  it("separates revisit batches and delegates retained known-listing queries", async () => {
    const { bridge, queue, knownListings } = fixture();
    expect(await bridge.knownListings(scan)).toEqual([]);
    expect(knownListings).toHaveBeenCalledWith(scan);
    await bridge.add(scan, products.slice(0, 1), scan.revisitBatchId);
    expect(queue.addScanDiscovery).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: scan.revisitBatchId }),
    );
  });

  it("does not submit an empty list", async () => {
    const { bridge, queue } = fixture();
    expect(await bridge.add(scan, [], scan.scanId)).toEqual({ added: 0 });
    expect(queue.add).not.toHaveBeenCalled();
    expect(queue.addScanDiscovery).not.toHaveBeenCalled();
  });

  it("accepts retained revisit products and assigns the scan source to the new shared batch", async () => {
    const { bridge, queue } = fixture();
    const retained = products.slice(0, 1).map((product) => ({
      ...product,
      sourceId: "66666666-6666-4666-8666-666666666666",
    }));
    await bridge.add(scan, retained, scan.revisitBatchId);
    expect(queue.add).toHaveBeenCalledExactlyOnceWith({
      channel: "amazon",
      batchId: scan.revisitBatchId,
      label: "brand scan: Herb Pharm",
      products: [{ ...retained[0], sourceId: scan.source.sourceId }],
    });
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
    expect(queue.addScanDiscovery).not.toHaveBeenCalled();
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
    expect(queue.addScanDiscovery).not.toHaveBeenCalled();
  });

  it("refuses a foreign scan channel", async () => {
    const { bridge, queue } = fixture();
    const foreign = { ...scan, source: { ...scan.source, channel: "gnc" as const } };
    await expect(bridge.add(foreign, products, scan.scanId)).rejects.toMatchObject({
      code: "QUEUE.SOURCE_CHANNEL_MISMATCH",
    });
    expect(queue.add).not.toHaveBeenCalled();
    expect(queue.addScanDiscovery).not.toHaveBeenCalled();
  });
});
