import { ChannelRegistry, type ListingScanMetrics } from "@crawl-automation/channels-core";
import { createLogger } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { BrandScanRunner, type BrandScanRunnerDeps } from "./brand-scan-runner.js";
import { ScanChannelSchema, type ScanRecord } from "./scan-model.js";
import type { BrandListing } from "./scan-listing.js";
import type { BrandScanStore } from "./ports.js";

const counts = { added: 1, following: 2, recent: 70 };
const metrics: ListingScanMetrics = { storeId: "test", unionSize: 1, attempts: [], reads: [] };
const product = {
  listingId: "one",
  variantId: null,
  url: "https://example.test/one",
  kind: "product" as const,
  title: null,
};
const listing: BrandListing = {
  products: [product],
  pages: [],
  full: true,
  families: 0,
  unresolvedFamilies: 0,
  credits: 0,
  metrics,
};

function fixture(channel = "gnc") {
  const scan = {
    scanId: "scan",
    revisitBatchId: "revisit",
    source: { channel, sourceId: "source", brandName: "Brand" },
  } as ScanRecord;
  const store = {
    claim: vi.fn(async () => [scan]),
    finish: vi.fn(),
    isCancellationRequested: vi.fn(async () => false),
    knownListings: vi.fn(async () => [{ ...product, sourceId: "source", listingId: "missing" }]),
  };
  const deps = {
    store: store as unknown as BrandScanStore,
    queue: { add: vi.fn(async () => counts) },
    amazonQueue: { knownListings: store.knownListings, add: vi.fn(async () => counts) },
    listings: { requestRevisits: vi.fn(async () => ({ queued: 1 })) },
    gatedListings: { [channel]: { read: vi.fn(async () => ({ ...listing })) } },
    registry: new ChannelRegistry([]),
    pages: { read: vi.fn() },
    browsers: {},
    log: createLogger({ name: "scan-metrics", destination: { write: () => undefined } }),
  } satisfies BrandScanRunnerDeps;
  return { store, deps, runner: new BrandScanRunner(deps) };
}

it.each(ScanChannelSchema.options)(
  "persists %s discovery counts and preserves reader metrics",
  async (channel) => {
    const test = fixture(channel);
    await test.runner.tick(new AbortController().signal);
    expect(test.store.finish).toHaveBeenCalledWith(
      "scan",
      expect.objectContaining({
        queued: counts.added,
        metrics: { ...metrics, ...counts },
      }),
    );
  },
);

it("keeps committed discovery counts when a subsequent revisit request fails", async () => {
  const test = fixture();
  test.deps.listings.requestRevisits.mockRejectedValueOnce(new Error("revisit failed"));
  await test.runner.tick(new AbortController().signal);
  expect(test.store.finish).toHaveBeenCalledWith(
    "scan",
    expect.objectContaining({
      state: "review",
      queued: 1,
      metrics: { ...metrics, ...counts },
      code: "BRAND_SCAN.UNRESOLVED",
    }),
  );
});

it("reports zero admission for an empty discovery without calling the queue", async () => {
  const test = fixture();
  test.deps.gatedListings.gnc?.read.mockResolvedValueOnce({
    ...listing,
    products: [],
    full: false,
  });
  await test.runner.tick(new AbortController().signal);
  expect(test.deps.queue.add).not.toHaveBeenCalled();
  expect(test.store.finish).toHaveBeenCalledWith(
    "scan",
    expect.objectContaining({
      queued: 0,
      metrics: { ...metrics, added: 0, following: 0, recent: 0 },
    }),
  );
});
