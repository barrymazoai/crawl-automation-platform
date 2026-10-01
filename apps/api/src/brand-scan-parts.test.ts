import { Writable } from "node:stream";
import { PostgresBrandScans } from "@crawl-automation/adapters";
import type {
  ListingStateService,
  QueueService,
  ScanRecord,
  ScanSource,
} from "@crawl-automation/app";
import { configuredDtcSites } from "@crawl-automation/channel-dtc";
import { amazonBrandScan } from "@crawl-automation/channel-amazon";
import { ListingPages, type ListingPage } from "@crawl-automation/channels-core";
import {
  wholeFoodsAdapter,
  WholeFoodsHttpScanSettingsSchema,
} from "@crawl-automation/channels-wholefoods";
import { createLogger, type Database, type TemporalClient } from "@crawl-automation/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrandScanSettingsSchema } from "./brand-scan-config.js";
import { brandScanParts, browserScanners } from "./brand-scan-parts.js";
import fixture from "./fixtures/api-config.json" with { type: "json" };

const storeUrl =
  "https://www.amazon.com/stores/HerbPharm/page/11111111-1111-4111-8111-111111111111";
const searchUrl = "https://www.amazon.com/s?rh=p_89%3AHerb+Pharm";
const wholeUrl = "https://www.wholefoodsmarket.com/grocery/search?k=Herb+Pharm&rh=p_123%3A12345";
const dtcUrl = "https://shop.example/collections/all";
const dtcSites = configuredDtcSites({
  sites: [{ siteKey: "shop.example", platform: "shopify", catalogUrl: dtcUrl }],
});
const requestId = "11111111-1111-4111-8111-111111111111";
const log = createLogger({
  name: "scan-routing-test",
  destination: new Writable({ write: (_chunk, _encoding, done) => done() }),
});
const source = (channel: string, url: string): ScanSource => ({
  sourceId: "22222222-2222-4222-8222-222222222222",
  brandId: "33333333-3333-4333-8333-333333333333",
  brandName: "Herb Pharm",
  channel,
  url,
  enabled: true,
});
const record = (source: ScanSource): ScanRecord => ({
  scanId: source.sourceId,
  requestId,
  source,
  revisitBatchId: "55555555-5555-4555-8555-555555555555",
  state: "queued",
  result: null,
  requestedAt: "2026-09-30T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
});
const page: ListingPage = {
  products: [
    {
      url: "https://www.amazon.com/dp/B0016B5U20",
      listingId: "B0016B5U20",
      variantId: null,
      title: "Herb Pharm",
      kind: "product",
    },
  ],
  cards: 1,
  nextPage: null,
  statedTotal: 1,
};

function setup(sources: ScanSource[], browserQueue: string | null = "browser", sites = dtcSites) {
  const scans: ScanRecord[] = [];
  vi.spyOn(PostgresBrandScans.prototype, "enabledSources").mockResolvedValue(sources);
  vi.spyOn(PostgresBrandScans.prototype, "sources").mockResolvedValue(sources);
  const request = vi
    .spyOn(PostgresBrandScans.prototype, "request")
    .mockImplementation(async (_id, rows) => {
      scans.push(...rows.map(record));
      return scans;
    });
  vi.spyOn(PostgresBrandScans.prototype, "claim").mockResolvedValue(scans);
  const known = vi.spyOn(PostgresBrandScans.prototype, "knownListings").mockResolvedValue([]);
  const finish = vi.spyOn(PostgresBrandScans.prototype, "finish").mockResolvedValue();
  const read = vi.spyOn(ListingPages.prototype, "read").mockResolvedValue({
    body: "retained HTTP page",
    archiveKey: "tests/v3/listing.html",
    creditCost: 1,
    fromArchive: false,
  });
  vi.spyOn(amazonBrandScan, "parsePage").mockReturnValue({ ...page, capped: false });
  const start = vi.fn(async () => ({
    result: async () => ({
      pages: [page],
      complete: true,
      soldHere: true,
      archiveKeys: ["browser.json"],
    }),
    cancel: vi.fn(),
  }));
  const queue = { add: vi.fn(async () => ({ added: 1 })) };
  const parts = brandScanParts({
    database: {} as Database,
    dtcSites: sites,
    queue: queue as unknown as QueueService,
    listingStates: { requestRevisits: vi.fn() } as unknown as ListingStateService,
    settings: BrandScanSettingsSchema.parse({
      ...fixture.brandScans,
      wholefoods: { brandScanMode: "browser" },
      browserQueue: browserQueue ?? undefined,
    }),
    temporal: { client: { workflow: { start } } } as unknown as TemporalClient,
    log,
  });
  return { ...parts, request, finish, read, start, queue, scans, known };
}

afterEach(() => vi.restoreAllMocks());

it("wires the configured Swanson resolver and JSON reader into the API runner", async () => {
  const url = "https://www.swansonvitamins.com/collections/brand-herb-pharm";
  const test = setup([source("swanson", url)]);
  test.read.mockImplementation(async (request) => ({
    body:
      request.label === "resolve"
        ? '<constructor-plp data-collection-title="Herb Pharm" />'
        : JSON.stringify({
            response: {
              total_num_results: 1,
              results: [{ value: "Herb", data: { url: "herb", id: "HPH001" } }],
            },
          }),
    archiveKey: request.label,
    creditCost: 1,
    fromArchive: false,
  }));
  await test.brandScans.request({ requestId, channel: "swanson" });
  await test.runner?.tick(new AbortController().signal);
  expect(test.read.mock.calls.map(([request]) => request.answer)).toEqual(["json"]);
  const api = new URL(test.read.mock.calls[0]?.[0].url ?? "");
  expect(api.origin).toBe("https://ac.cnstrc.com");
  expect(api.pathname).toBe("/browse/brand/Herb%20Pharm");
  expect(api.searchParams.get("key")).toBe("test-public-constructor-key");
  expect(test.finish).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      full: true,
      statedTotal: 1,
      products: 1,
      nameResolution: { brandName: "Herb Pharm", usedFallback: false },
    }),
  );
});

describe("brand-scan API source routing", () => {
  it.each([
    ["amazon", storeUrl],
    ["wholefoods", wholeUrl],
    ["costco", "https://www.costco.com/protein.html?refinement=brands%3DExample"],
  ])("runs %s browser sources through the browser workflow", async (channel, url) => {
    const test = setup([source(channel, url)]);
    await test.brandScans.request({ requestId, channel });
    await test.runner?.tick(new AbortController().signal);
    const normalized = test.scans[0]?.source.url;
    expect(test.start).toHaveBeenCalledExactlyOnceWith(
      "BrowserScanWorkflow",
      expect.objectContaining({
        taskQueue: "browser",
        args: [
          {
            channel,
            capture: "browser",
            scanId: test.scans[0]?.scanId,
            sourceUrl: normalized,
            sourceId: test.scans[0]?.source.sourceId,
            ...(["wholefoods", "costco"].includes(channel)
              ? {
                  gapAfterSeconds: 60,
                  cooldownSeconds: 1800,
                  resources: {
                    queue: "v3.resources.v1",
                    maxWaitSeconds: 900,
                    activities: {
                      scanBrandInBrowser: [{ resourceId: `${channel}-brand-scan`, units: 1 }],
                    },
                  },
                }
              : {}),
          },
        ],
      }),
    );
    expect(test.read).not.toHaveBeenCalled();
    expect(test.finish).toHaveBeenCalledWith(
      test.scans[0]?.scanId,
      expect.objectContaining({
        state: channel === "wholefoods" ? "partial" : "complete",
        full: channel !== "wholefoods",
        products: 1,
        queued: 1,
        credits: 0,
      }),
    );
    expect(test.queue.add).toHaveBeenCalledWith(expect.objectContaining({ channel }));
  });

  it.each([searchUrl, searchUrl + "&srs=123456"])(
    "runs Amazon search/brand source %s over HTTP even with the browser configured",
    async (url) => {
      const test = setup([source("amazon", url)]);
      await test.brandScans.request({ requestId, channel: "amazon" });
      await test.runner?.tick(new AbortController().signal);
      expect(test.start).not.toHaveBeenCalled();
      expect(test.read).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          channel: "amazon",
          url: amazonBrandScan.pageUrl(url, 1),
        }),
        expect.any(AbortSignal),
      );
      expect(test.finish).toHaveBeenCalledWith(
        test.scans[0]?.scanId,
        expect.objectContaining({
          state: "complete",
          products: 1,
          queued: 1,
          credits: 1,
        }),
      );
      expect(test.known).toHaveBeenCalledWith(test.scans[0]?.source, test.scans[0]?.scanId);
    },
  );

  it("routes two Amazon sources independently within the same request", async () => {
    const test = setup([
      source("amazon", searchUrl),
      { ...source("amazon", storeUrl), sourceId: "66666666-6666-4666-8666-666666666666" },
    ]);
    await test.brandScans.request({ requestId, channel: "amazon" });
    await test.runner?.tick(new AbortController().signal);
    expect(test.read).toHaveBeenCalledTimes(1);
    expect(test.start).toHaveBeenCalledTimes(1);
    expect(test.finish).toHaveBeenCalledTimes(2);
  });

  it("keeps HTTP scanning available without a browser queue", async () => {
    const test = setup([source("amazon", searchUrl)], null);
    await test.brandScans.request({ requestId, channel: "amazon" });
    await test.runner?.tick(new AbortController().signal);
    expect(test.read).toHaveBeenCalledTimes(1);
    expect(test.start).not.toHaveBeenCalled();
  });

  it.each([
    ["amazon", storeUrl],
    ["wholefoods", wholeUrl],
    ["costco", "https://www.costco.com/protein.html?refinement=brands%3DExample"],
  ])(
    "refuses %s browser sources before enqueueing when the browser queue is absent",
    async (channel, url) => {
      const test = setup([source(channel, url)], null);
      await expect(test.brandScans.request({ requestId, channel })).rejects.toMatchObject({
        code: "BRAND_SCAN.BROWSER_NOT_CONFIGURED",
      });
      expect(test.request).not.toHaveBeenCalled();
      expect(test.read).not.toHaveBeenCalled();
      expect(test.start).not.toHaveBeenCalled();
    },
  );

  it("declares Whole Foods browser capture independently of product settings", () => {
    const adapter = wholeFoodsAdapter(
      {
        storeId: "12345",
        label: "Test store",
        postalCode: "12345",
      },
      WholeFoodsHttpScanSettingsSchema.parse({ brandScanMode: "browser" }),
    );
    expect(adapter.scanCapture?.(wholeUrl)).toBe("browser");
  });

  it.each([
    storeUrl.replace("amazon.com", "amazon.com.example.test"),
    storeUrl.replace("https://", "https://user@"),
    "https://www.amazon.com/stores/page/not-a-uuid",
    "https://www.amazon.com/s?k=Herb+Pharm",
  ])("rejects invalid Amazon source %s before saving or capturing", async (url) => {
    const test = setup([source("amazon", url)]);
    await expect(test.brandScans.request({ requestId, channel: "amazon" })).rejects.toMatchObject({
      code: "BRAND_SCAN.URL",
    });
    expect(test.request).not.toHaveBeenCalled();
    expect(test.read).not.toHaveBeenCalled();
    expect(test.start).not.toHaveBeenCalled();
  });
});

it("accepts a DTC brand request through the application scan schema", async () => {
  const test = setup([source("dtc", dtcUrl)]);
  await test.brandScans.request({ requestId, channel: "dtc" });
  await test.runner?.tick(new AbortController().signal);
  expect(test.start).toHaveBeenCalledOnce();
  expect(test.read).not.toHaveBeenCalled();
});

it("wires the DTC scanner to the browser workflow with a configured catalog", async () => {
  const start = vi.fn(async () => ({
    result: async () => ({ pages: [], complete: true, soldHere: true, archiveKeys: [] }),
    cancel: vi.fn(),
  }));
  const settings = BrandScanSettingsSchema.parse({
    ...fixture.brandScans,
    browserQueue: "browser",
  });
  const temporal = { client: { workflow: { start } } } as unknown as TemporalClient;
  const scanner = browserScanners(settings, temporal, dtcSites).dtc;
  expect(scanner?.sourceUrl(dtcUrl)).toBe(dtcUrl);
  expect(() => scanner?.sourceUrl("https://unknown.example/collections/all")).toThrow();
  await scanner?.scan({ scanId: requestId, sourceUrl: dtcUrl }, new AbortController().signal);
  expect(start).toHaveBeenCalledWith(
    "BrowserScanWorkflow",
    expect.objectContaining({
      taskQueue: "browser",
      args: [{ channel: "dtc", capture: "browser", scanId: requestId, sourceUrl: dtcUrl }],
    }),
  );
});

it("routes a named DTC source by scanCapture through the API runner, never HTTP", async () => {
  const row = source("dtc", dtcUrl);
  const test = setup([row]);
  await test.brandScans.request({ requestId, sourceIds: [row.sourceId] });
  await test.runner?.tick(new AbortController().signal);
  expect(test.start).toHaveBeenCalledWith(
    "BrowserScanWorkflow",
    expect.objectContaining({
      taskQueue: "browser",
      args: [
        {
          channel: "dtc",
          capture: "browser",
          scanId: row.sourceId,
          sourceId: row.sourceId,
          sourceUrl: dtcUrl,
        },
      ],
    }),
  );
  expect(test.read).not.toHaveBeenCalled();
  expect(test.queue.add).toHaveBeenCalledWith(expect.objectContaining({ channel: "dtc" }));
});

it("routes one collection of a multi-brand site and queues its database source ID", async () => {
  const alphaUrl = "https://shop.example/collections/alpha";
  const row = source("dtc", alphaUrl);
  const sites = configuredDtcSites({
    sites: [
      {
        siteKey: "shop.example",
        platform: "shopify",
        kind: "multi-brand",
        brands: [
          { brand: "Alpha", catalogUrl: alphaUrl },
          { brand: "Beta", catalogUrl: "https://shop.example/collections/beta" },
        ],
      },
    ],
  });
  const test = setup([row], "browser", sites);
  await test.brandScans.request({ requestId, sourceIds: [row.sourceId] });
  await test.runner?.tick(new AbortController().signal);
  expect(test.start).toHaveBeenCalledExactlyOnceWith(
    "BrowserScanWorkflow",
    expect.objectContaining({
      args: [
        {
          channel: "dtc",
          capture: "browser",
          scanId: row.sourceId,
          sourceId: row.sourceId,
          sourceUrl: alphaUrl,
        },
      ],
    }),
  );
  expect(test.queue.add).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      channel: "dtc",
      products: [expect.objectContaining({ sourceId: row.sourceId })],
    }),
  );
  expect(test.read).not.toHaveBeenCalled();
});
