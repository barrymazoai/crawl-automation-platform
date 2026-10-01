import { expect, it, vi } from "vitest";
import { ChannelRegistry, type ChannelAdapter } from "@crawl-automation/channels-core";
import { createLogger } from "@crawl-automation/platform";
import { BrandScanRunner } from "./brand-scan-runner.js";
import type { BrowserBrandScan, BrandScanStore } from "./ports.js";
import type { ScanRecord } from "./scan-model.js";
import type { BrandListing } from "./scan-listing.js";

const product = {
  url: "https://example.test/product",
  listingId: "one",
  variantId: null,
  kind: "product" as const,
  title: null,
};
const listing: BrandListing = {
  pages: [],
  products: [product],
  full: true,
  credits: 1,
  families: 0,
  unresolvedFamilies: 0,
};
const scan = {
  scanId: "scan",
  source: {
    sourceId: "source",
    channel: "gnc",
    brandName: "Brand",
    url: "https://example.test/brand",
  },
  revisitBatchId: "revisit",
} as ScanRecord;

function fixture() {
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  const store = {
    claim: vi.fn(async () => [scan]),
    isCancellationRequested: vi.fn(async () => cancelled),
    finish: vi.fn(),
    knownListings: vi.fn(async () => []),
  } as unknown as BrandScanStore;
  const adapter = {
    id: "gnc",
    httpPolicy: { origins: ["https://example.test"] },
    brandScan: {
      sourceUrl: (url: string) => url,
      pageUrl: (url: string) => url,
      answer: "json",
      maxBytes: 1000,
      maxPages: 2,
      parsePage: () => ({ products: [product], cards: 1, nextPage: 2, statedTotal: 2 }),
      complete: () => true,
    },
  } as unknown as ChannelAdapter;
  const read = vi.fn(async () => {
    cancel();
    return { body: "{}", archiveKey: "retained.json", creditCost: 1, fromArchive: false };
  });
  const deps = {
    store,
    registry: new ChannelRegistry([adapter]),
    pages: { read },
    browsers: {},
    queue: { add: vi.fn(async () => ({ added: 1 })) },
    listings: { requestRevisits: vi.fn(async () => ({ queued: 1 })) },
    log: createLogger({ name: "cancel-test", destination: { write: () => undefined } }),
  };
  return { deps, cancel, read, store, runner: new BrandScanRunner(deps) };
}

it("stops a running direct scan at the next request boundary, after the current archive finishes", async () => {
  const test = fixture();
  await test.runner.tick(new AbortController().signal);
  expect(test.read).toHaveBeenCalledOnce();
  expect(test.store.finish).toHaveBeenCalledWith(
    "scan",
    expect.objectContaining({
      state: "cancelled",
      full: false,
      queued: 0,
      code: "BRAND_SCAN.CANCELLED",
    }),
  );
  expect(test.deps.queue.add).not.toHaveBeenCalled();
  expect(test.deps.listings.requestRevisits).not.toHaveBeenCalled();
});

it("waits for a reattached gated execution to settle before acknowledging its cancellation", async () => {
  const test = fixture();
  let settle: (value: BrandListing) => void = () => undefined;
  const read = vi.fn(
    () =>
      new Promise<BrandListing>((resolve) => {
        settle = resolve;
      }),
  );
  const runner = new BrandScanRunner({ ...test.deps, gatedListings: { gnc: { read } } });
  test.cancel();
  const pending = runner.tick(new AbortController().signal);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  expect(test.store.finish).not.toHaveBeenCalled();
  settle(listing);
  await pending;
  expect(test.store.finish).toHaveBeenCalledWith(
    "scan",
    expect.objectContaining({
      state: "cancelled",
      products: 1,
      credits: 1,
      queued: 0,
      full: false,
    }),
  );
  expect(test.read).not.toHaveBeenCalled();
  expect(test.deps.queue.add).not.toHaveBeenCalled();
});

it("keeps the count of a committed queue batch when cancellation arrives during that write", async () => {
  const test = fixture();
  test.deps.queue.add.mockImplementation(async () => {
    test.cancel();
    return { added: 1 };
  });
  const runner = new BrandScanRunner({
    ...test.deps,
    gatedListings: { gnc: { read: async () => listing } },
  });
  await runner.tick(new AbortController().signal);
  expect(test.store.finish).toHaveBeenCalledWith(
    "scan",
    expect.objectContaining({
      state: "cancelled",
      products: 1,
      queued: 1,
      missing: 0,
      full: false,
    }),
  );
  expect(test.deps.listings.requestRevisits).not.toHaveBeenCalled();
});

it("reattaches a cancelled stale browser scan and waits for its page cleanup before terminating", async () => {
  const test = fixture();
  let settle: (result: BrowserBrandScan) => void = () => undefined;
  const scan = vi.fn(
    () =>
      new Promise<BrowserBrandScan>((resolve) => {
        settle = resolve;
      }),
  );
  const runner = new BrandScanRunner({
    ...test.deps,
    registry: new ChannelRegistry([]),
    browsers: { gnc: { sourceUrl: (url) => url, scan } },
  });
  test.cancel();
  const pending = runner.tick(new AbortController().signal);
  await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce());
  expect(test.store.finish).not.toHaveBeenCalled();
  settle({ pages: [], complete: false, soldHere: true, archiveKeys: [] });
  await pending;
  expect(test.store.finish).toHaveBeenCalledWith(
    "scan",
    expect.objectContaining({
      state: "cancelled",
      full: false,
      queued: 0,
    }),
  );
  expect(test.deps.queue.add).not.toHaveBeenCalled();
});
