import { expect, it, vi } from "vitest";
import { ChannelRegistry, ListingPages } from "@crawl-automation/channels-core";
import {
  wholeFoodsAdapter,
  WHOLE_FOODS_STORE,
  WholeFoodsHttpScanSettingsSchema,
  wholeFoodsBrandSearchUrl,
} from "@crawl-automation/channels-wholefoods";
import {
  BrandScanRunner,
  type BrandScanStore,
  type ScanRecord,
  type ScanResult,
} from "@crawl-automation/app";
import { createLogger, type ObjectStore, type ScraperApiPage } from "@crawl-automation/platform";
import { readListing } from "@crawl-automation/app";
import { workerChannelRegistry } from "../channel-registry.js";

const source = {
  sourceId: "source",
  channel: "wholefoods",
  brandName: "Nordic Naturals",
  url: wholeFoodsBrandSearchUrl({ name: "Nordic Naturals", amazonBrandId: "234060" }),
};
const scan = { scanId: "scan", source, revisitBatchId: "revisit" } as ScanRecord;
const body = (asins: string[]) =>
  JSON.stringify({
    mainResultSet: {
      searchResults: asins.map((asin) => ({ asin })),
      availableTotalResultCount: asins.length,
    },
  });
const asins = ["B000000001", "B000000002", "B000000003"];

function fixture(answers: string[]) {
  const settings = WholeFoodsHttpScanSettingsSchema.parse({
    readPauseMs: 0,
    emptyPauseMs: 0,
    maxEmptyAttempts: 1,
  });
  const data = new Map<string, Uint8Array>();
  const remote: ObjectStore = {
    read: async (key) => data.get(key) ?? null,
    create: async (key, bytes) => {
      data.set(key, Buffer.from(bytes));
      return "created";
    },
  };
  const get = vi.fn(async (): Promise<ScraperApiPage> => ({
    status: 200,
    url: source.url,
    bytes: Buffer.from(answers.shift() ?? "unexpected"),
    contentType: "application/json",
    contentEncoding: null,
    creditCost: 1,
  }));
  const pages = new ListingPages({
    client: { provider: "scraperapi-sync/1", get },
    remote,
    settings: {
      routeId: "test",
      egressId: "test",
      defaults: {
        countryCode: "us",
        sessionNumber: null,
        render: false,
        premium: false,
      },
      channels: {},
    },
  });
  const registry = new ChannelRegistry([wholeFoodsAdapter(WHOLE_FOODS_STORE, settings)]);
  return { readers: { registry, pages, browsers: {} }, data, get };
}

it("archives each observation byte-exact and queues the first-seen union through the shared runner", async () => {
  const originals = [
    body([asins[1] ?? "", asins[0] ?? ""]),
    body([asins[2] ?? "", asins[1] ?? ""]),
  ];
  const test = fixture([...originals]);
  const listing = await readListing(test.readers, scan, new AbortController().signal);
  expect(listing.products.map((product) => product.listingId)).toEqual([
    asins[1],
    asins[0],
    asins[2],
  ]);
  expect(listing).toMatchObject({
    full: false,
    statedTotal: 2,
    credits: 2,
    metrics: { catalogueAgreement: false, unionSize: 3 },
  });
  for (let index = 0; index < originals.length; index++) {
    const key = `v3/brand-scans/scan/read-${index + 1}-page-1-attempt-1.json`;
    expect(Buffer.from(test.data.get(key) ?? []).toString()).toBe(originals[index]);
    expect(test.data.has(key.replace(".json", ".record.json"))).toBe(true);
  }
  const reused = await readListing(test.readers, scan, new AbortController().signal);
  expect(test.get).toHaveBeenCalledTimes(2);
  expect(reused.credits).toBe(2);
  expect(reused.metrics?.attempts.every((attempt) => attempt.fromArchive)).toBe(true);
  const runner = runnerFixture(test);
  await runner.runner.tick(new AbortController().signal);
  expect(runner.add).toHaveBeenCalledWith(
    expect.objectContaining({
      products: listing.products.map((product) => ({
        sourceId: "source",
        url: product.url,
        listingId: product.listingId,
        variantId: null,
      })),
    }),
  );
  expect(runner.results[0]).toMatchObject({
    state: "partial",
    products: 3,
    statedTotal: 2,
    credits: 2,
    full: false,
    missing: 0,
    metrics: { unionSize: 3, catalogueAgreement: false },
  });
  expect(runner.requestRevisits).not.toHaveBeenCalled();
});

function runnerFixture(test: ReturnType<typeof fixture>) {
  const results: ScanResult[] = [];
  const store = {
    claim: async () => [scan],
    finish: async (_id: string, result: ScanResult) => {
      results.push(result);
    },
    knownListings: async () => [
      { sourceId: "source", url: "https://example.test/old", listingId: "old", variantId: null },
    ],
  } as unknown as BrandScanStore;
  const add = vi.fn(async () => ({ added: 3 }));
  const requestRevisits = vi.fn(async () => ({ queued: 1 }));
  const runner = new BrandScanRunner({
    ...test.readers,
    store,
    queue: { add },
    listings: { requestRevisits },
    log: createLogger({ name: "http-scan", destination: { write: () => undefined } }),
  });
  return { runner, results, add, requestRevisits };
}

it("retains a partial list and failure telemetry without scheduling missing-listing revisits", async () => {
  const test = fixture([body([asins[0] ?? ""]), "not JSON"]);
  const runner = runnerFixture(test);
  await runner.runner.tick(new AbortController().signal);
  expect(runner.results[0]).toMatchObject({
    state: "partial",
    products: 1,
    full: false,
    missing: 0,
    credits: 2,
    code: "BRAND_SCAN.NOT_JSON",
    metrics: { unionSize: 1 },
  });
  expect(runner.requestRevisits).not.toHaveBeenCalled();
});

it("keeps first-read throttling unresolved and preserves all empty attempts in Review", async () => {
  const runner = runnerFixture(fixture([body([]), body([])]));
  await runner.runner.tick(new AbortController().signal);
  expect(runner.results[0]).toMatchObject({
    state: "review",
    full: false,
    products: 0,
    credits: 2,
    code: "WHOLEFOODS.SEARCH_THROTTLED",
    cooldownRequested: true,
  });
  expect(runner.results[0]).not.toHaveProperty("soldHere");
  expect(runner.add).not.toHaveBeenCalled();
  expect(runner.requestRevisits).not.toHaveBeenCalled();
});

it("defaults worker routing to HTTP and keeps the explicitly selected browser reader", () => {
  const registry = workerChannelRegistry({});
  expect(registry.get("wholefoods").scanCapture?.(source.url)).toBe("http");
  const browser = wholeFoodsAdapter(
    WHOLE_FOODS_STORE,
    WholeFoodsHttpScanSettingsSchema.parse({ brandScanMode: "browser" }),
  );
  expect(browser.scanCapture?.(source.url)).toBe("browser");
  expect(browser.brandScan?.answer).toBe("html");
});
