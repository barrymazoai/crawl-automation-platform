import { Writable } from "node:stream";
import { PostgresBrandScans } from "@crawl-automation/adapters";
import type {
  ListingStateService,
  QueueService,
  ScanRecord,
  ScanSource,
} from "@crawl-automation/app";
import { amazonBrandScan } from "@crawl-automation/channel-amazon";
import { ListingPages, type ListingPage } from "@crawl-automation/channels-core";
import { wholeFoodsAdapter } from "@crawl-automation/channels-wholefoods";
import { createLogger, type Database, type TemporalClient } from "@crawl-automation/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrandScanSettingsSchema } from "./brand-scan-config.js";
import { brandScanParts } from "./brand-scan-parts.js";
import fixture from "./fixtures/api-config.json" with { type: "json" };

const storeUrl =
  "https://www.amazon.com/stores/HerbPharm/page/11111111-1111-4111-8111-111111111111";
const searchUrl = "https://www.amazon.com/s?rh=p_89%3AHerb+Pharm";
const wholeUrl = "https://www.wholefoodsmarket.com/grocery/search?k=Herb+Pharm&rh=p_123%3A12345";
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

function setup(sources: ScanSource[], browserQueue: string | null = "browser") {
  const scans: ScanRecord[] = [];
  vi.spyOn(PostgresBrandScans.prototype, "enabledSources").mockResolvedValue(sources);
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
    queue: queue as unknown as QueueService,
    listingStates: { requestRevisits: vi.fn() } as unknown as ListingStateService,
    settings: BrandScanSettingsSchema.parse({
      ...fixture.brandScans,
      browserQueue: browserQueue ?? undefined,
    }),
    temporal: { client: { workflow: { start } } } as unknown as TemporalClient,
    log,
  });
  return { ...parts, request, finish, read, start, queue, scans, known };
}

afterEach(() => vi.restoreAllMocks());

describe("brand-scan API source routing", () => {
  it.each([
    ["amazon", storeUrl],
    ["wholefoods", wholeUrl],
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
          { channel, capture: "browser", scanId: test.scans[0]?.scanId, sourceUrl: normalized },
        ],
      }),
    );
    expect(test.read).not.toHaveBeenCalled();
    expect(test.finish).toHaveBeenCalledWith(
      test.scans[0]?.scanId,
      expect.objectContaining({
        state: "complete",
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
    const adapter = wholeFoodsAdapter({
      storeId: "12345",
      label: "Test store",
      postalCode: "12345",
    });
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
