import {
  brandScanErrors,
  ChannelRegistry,
  type BrandScanReader,
  type ChannelAdapter,
  type ListedProduct,
} from "@crawl-automation/channels-core";
import { Writable } from "node:stream";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import type { AddProducts, AddToQueue, QueuedProduct } from "../queue/queue-model.js";
import { BrandScanRunner } from "./brand-scan-runner.js";
import type { BrandScanStore, BrowserBrandScanners, ListingPageReader } from "./ports.js";
import type { ScanRecord, ScanResult } from "./scan-model.js";
import type { AmazonScanQueue } from "./amazon-scan-queue.js";
const ORIGIN = "https://shop.example";
const product = (id: string, kind: ListedProduct["kind"] = "product"): ListedProduct => ({
  url: `${ORIGIN}/p/${id}`,
  listingId: id,
  variantId: null,
  title: null,
  kind,
});
function reader(options: { full?: boolean; maxPages?: number } = {}): BrandScanReader {
  return {
    sourceUrl: (url) => url,
    pageUrl: (source, page) => `${source}?page=${page}`,
    answer: "json",
    maxPages: options.maxPages ?? 5,
    maxBytes: 1_000_000,
    parsePage: ({ body }) => {
      const { ids, next, capped } = JSON.parse(body) as {
        ids: string[];
        next: number | null;
        capped?: boolean;
      };
      const products = ids.map((id) => product(id, id.startsWith("fam-") ? "family" : "product"));
      return { products, cards: ids.length, nextPage: next, statedTotal: null, capped };
    },
    complete: () => options.full ?? true,
    familyMembers: (page) => (page.html ? page.html.split(",").map((id) => product(id)) : []),
  };
}
function adapter(
  scanReader: BrandScanReader,
  channel: ChannelAdapter["id"] = "gnc",
): ChannelAdapter {
  return {
    id: channel,
    captureModes: ["http"],
    httpPolicy: { origins: [ORIGIN], maxBytes: 1_000_000, timeoutMs: 1_000 },
    brandScan: scanReader,
    productAddress: () => ({ url: ORIGIN, listingId: "x", variantId: null }),
    parseProduct: () => {
      throw new Error("not used");
    },
  };
}
const scan: ScanRecord = {
  scanId: "5f7a3c9e-6f0b-4c1e-9a3b-111111111111",
  requestId: "5f7a3c9e-6f0b-4c1e-9a3b-222222222222",
  source: {
    sourceId: "5f7a3c9e-6f0b-4c1e-9a3b-333333333333",
    brandId: "5f7a3c9e-6f0b-4c1e-9a3b-444444444444",
    brandName: "Nordic Naturals",
    channel: "gnc",
    url: `${ORIGIN}/brands/nordic`,
    enabled: true,
  },
  revisitBatchId: "5f7a3c9e-6f0b-4c1e-9a3b-555555555555",
  state: "running",
  result: null,
  requestedAt: "2026-09-29T00:00:00.000Z",
  startedAt: "2026-09-29T00:00:01.000Z",
  finishedAt: null,
};
function setup(input: {
  bodies: Record<string, string>;
  known?: string[];
  scanReader?: BrandScanReader;
  browsers?: BrowserBrandScanners;
  channel?: ChannelAdapter["id"];
  capture?: "browser";
}) {
  const finished: ScanResult[] = [];
  const known: QueuedProduct[] = (input.known ?? []).map((id) => ({
    sourceId: scan.source.sourceId,
    url: `${ORIGIN}/p/${id}`,
    listingId: id,
    variantId: null,
  }));
  const store = {
    isCancellationRequested: vi.fn(async () => false),
    claim: vi.fn(async () => [
      {
        ...scan,
        source: { ...scan.source, channel: input.channel ?? "gnc" },
      },
    ]),
    finish: vi.fn(async (_scanId: string, result: ScanResult) => void finished.push(result)),
    knownListings: vi.fn(async () => known),
  } as unknown as BrandScanStore;
  const pages: ListingPageReader = {
    read: vi.fn(async (request) => {
      const body = input.bodies[request.label];
      if (body === undefined) {
        throw brandScanErrors.create("BRAND_SCAN.NOT_FOUND");
      }
      return {
        body,
        archiveKey: `v3/brand-scans/${request.label}`,
        creditCost: 1,
        fromArchive: false,
      };
    }),
  };
  const lists: AddProducts[] = [];
  const queue = {
    add: vi.fn(async (list: AddToQueue) => {
      lists.push(list as AddProducts);
      return { added: 1 };
    }),
  };
  const listings = { requestRevisits: vi.fn(async () => ({ queued: 1 })) };
  const registry = new ChannelRegistry([
    {
      ...adapter(input.scanReader ?? reader(), input.channel),
      ...(input.capture ? { scanCapture: () => input.capture ?? "http" } : {}),
    },
  ]);
  const log = createLogger({
    name: "test",
    destination: new Writable({ write: (_c, _e, done) => done() }),
  });
  const browsers = input.browsers ?? {};
  const amazonQueue: AmazonScanQueue = {
    knownListings: vi.fn(async () => known),
    add: vi.fn(async () => ({ added: 1 })),
  };
  const deps = { store, pages, registry, browsers, queue, listings, log, amazonQueue };
  const runner = new BrandScanRunner(deps);
  return { runner, finished, queue, lists, listings, pages, store, amazonQueue, deps };
}
const signal = () => new AbortController().signal;
it.each([undefined, 0, 1, 2] as const)(
  "gates WF missing-listing revisits on API total proof %s, even when reads disagree",
  async (total) => {
    const fixture = setup({ bodies: {}, channel: "wholefoods", known: ["missing"] });
    const runner = new BrandScanRunner({
      ...fixture.deps,
      gatedListings: {
        wholefoods: {
          read: async () => ({
            pages: [],
            products: [product("seen")],
            families: 0,
            unresolvedFamilies: 0,
            credits: 2,
            full: true,
            statedTotal: total ?? null,
            metrics: {
              storeId: "10259",
              attempts: [],
              reads: ["read-1", "read-2"].map((read) => ({
                read,
                pages: 1,
                cards: 1,
                products: 1,
                availableCounts: [1],
                succeeded: false,
                code: null,
              })),
              unionSize: 1,
              readsFinished: true,
              catalogueAgreement: false,
              catalogueStable: false,
            },
          }),
        },
      },
    });
    await runner.tick(signal());
    expect(fixture.lists[0]?.products).toHaveLength(1);
    expect(fixture.finished[0]?.full).toBe(total === 1);
    expect(fixture.listings.requestRevisits).toHaveBeenCalledTimes(total === 1 ? 1 : 0);
  },
);

describe("brand scan runner", () => {
  it.each([true, false])(
    "persists name resolution with fallback=%s in the scan result",
    async (usedFallback) => {
      const scanReader = reader();
      const nameResolution = { brandName: "Resolved Brand", usedFallback };
      scanReader.resolve = vi.fn(({ url }) => ({ sourceUrl: url, nameResolution }));
      const fixture = setup({
        bodies: { "page-1": JSON.stringify({ ids: ["one"], next: null }) },
        scanReader,
      });
      await fixture.runner.tick(signal());
      expect(scanReader.resolve).toHaveBeenCalledWith({
        url: scan.source.url,
        brandName: scan.source.brandName,
      });
      expect(fixture.finished[0]).toMatchObject({ state: "complete", nameResolution });
    },
  );
  it("queues all Amazon scan products once, retains capped=true and never requests missing revisits", async () => {
    const bodies = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [
        `page-${index + 1}`,
        JSON.stringify({
          ids: ["B0016B5U20", `B00000000${index}`],
          next: index === 6 ? null : index + 2,
          capped: index === 6,
        }),
      ]),
    );
    const fixture = setup({
      bodies,
      known: ["B0016B5U20", "B999999999"],
      channel: "amazon",
      // The application's cap guard remains conservative even if a reader claims completeness.
      scanReader: reader({ maxPages: 7, full: true }),
    });
    await fixture.runner.tick(signal());
    expect(fixture.pages.read).toHaveBeenCalledTimes(7);
    expect(fixture.queue.add).not.toHaveBeenCalled();
    expect(fixture.amazonQueue.add).toHaveBeenCalledTimes(1);
    const queued = vi.mocked(fixture.amazonQueue.add).mock.calls[0];
    expect(queued?.[0].source.channel).toBe("amazon");
    expect(queued?.[1]).toHaveLength(8);
    expect(queued?.[2]).toBe(scan.scanId);
    expect(fixture.finished[0]).toMatchObject({
      state: "partial",
      full: false,
      capped: true,
      pages: 7,
      products: 8,
      knownListings: 1,
      newListings: 7,
      missing: 0,
      credits: 7,
    });
    expect(fixture.listings.requestRevisits).not.toHaveBeenCalled();
  });
  it("stops an Amazon scan on an empty page and preserves earlier products", async () => {
    const fixture = setup({
      channel: "amazon",
      scanReader: reader({ full: false }),
      bodies: {
        "page-1": JSON.stringify({ ids: ["B0016B5U20"], next: 2 }),
        "page-2": JSON.stringify({ ids: [], next: 3 }),
      },
    });
    await fixture.runner.tick(signal());
    expect(fixture.pages.read).toHaveBeenCalledTimes(2);
    expect(fixture.finished[0]).toMatchObject({
      pages: 2,
      products: 1,
      full: false,
      capped: false,
    });
    expect(vi.mocked(fixture.amazonQueue.add).mock.calls[0]?.[1][0]?.listingId).toBe("B0016B5U20");
    expect(fixture.listings.requestRevisits).not.toHaveBeenCalled();
  });
  it("queues missing Amazon products through the same Amazon bridge only after a full scan", async () => {
    const fixture = setup({
      channel: "amazon",
      known: ["B999999999"],
      bodies: { "page-1": JSON.stringify({ ids: ["B0016B5U20"], next: null }) },
    });
    await fixture.runner.tick(signal());
    expect(fixture.amazonQueue.add).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fixture.amazonQueue.add).mock.calls[1]).toEqual([
      expect.any(Object),
      [expect.objectContaining({ listingId: "B999999999" })],
      scan.revisitBatchId,
    ]);
    expect(fixture.finished[0]).toMatchObject({ full: true, capped: false, missing: 1 });
    expect(fixture.listings.requestRevisits).not.toHaveBeenCalled();
  });
  it("fails before any paid page read if the Amazon queue bridge is not configured", async () => {
    const fixture = setup({ channel: "amazon", bodies: {} });
    const { amazonQueue: _amazon, ...deps } = fixture.deps;
    await new BrandScanRunner(deps).tick(signal());
    expect(fixture.pages.read).not.toHaveBeenCalled();
    expect(fixture.finished[0]).toMatchObject({
      state: "review",
      code: "BRAND_SCAN.NOT_CONFIGURED",
    });
  });
  it("queues every listed product in one list, and revisits known listings a full scan no longer shows", async () => {
    const bodies = {
      "page-1": JSON.stringify({ ids: ["100001", "100002"], next: 2 }),
      "page-2": JSON.stringify({ ids: ["100003"], next: null }),
    };
    const fixture = setup({ bodies, known: ["100001", "999999"] });
    await fixture.runner.tick(signal());
    const added = fixture.lists[0];
    expect(added?.batchId).toBe(scan.scanId);
    expect(added?.products.map((item) => item.listingId)).toEqual(["100001", "100002", "100003"]);
    expect(fixture.listings.requestRevisits).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "full",
        batchId: scan.revisitBatchId,
        listings: [expect.objectContaining({ listingId: "999999" })],
      }),
    );
    expect(fixture.finished[0]).toMatchObject({
      state: "complete",
      pages: 2,
      products: 3,
      newListings: 2,
      knownListings: 1,
      missing: 1,
      credits: 2,
    });
  });
  it("expands families into their members; a family with no members makes the scan not full", async () => {
    const bodies = {
      "page-1": JSON.stringify({ ids: ["100001", "fam-shake", "fam-empty"], next: null }),
      "family-fam-shake": "200001,200002",
      "family-fam-empty": "",
    };
    const fixture = setup({ bodies, known: ["999999"] });
    await fixture.runner.tick(signal());
    const added = fixture.lists[0];
    expect(added?.products.map((item) => item.listingId)).toEqual(["100001", "200001", "200002"]);
    expect(fixture.finished[0]).toMatchObject({
      state: "partial",
      families: 2,
      unresolvedFamilies: 1,
      full: false,
    });
    expect(fixture.listings.requestRevisits).not.toHaveBeenCalled();
  });
  it("never suggests delisting after a partial scan", async () => {
    const bodies = { "page-1": JSON.stringify({ ids: ["100001"], next: null }) };
    const fixture = setup({ bodies, known: ["999999"], scanReader: reader({ full: false }) });
    await fixture.runner.tick(signal());
    expect(fixture.finished[0]).toMatchObject({
      state: "partial",
      full: false,
      newListings: 1,
      knownListings: 0,
      missing: 0,
    });
    expect(fixture.listings.requestRevisits).not.toHaveBeenCalled();
  });

  it.each([
    [{ "page-1": JSON.stringify({ ids: ["100001"], next: 2 }) }, "BRAND_SCAN.NOT_FOUND"],
    [
      {
        "page-1": JSON.stringify({ ids: ["1"], next: 2 }),
        "page-2": JSON.stringify({ ids: ["2"], next: 3 }),
      },
      "BRAND_SCAN.PAGE_LIMIT",
    ],
  ])("ends a failed scan as a Review with the failure's own code (%#)", async (bodies, code) => {
    const fixture = setup({ bodies, scanReader: reader({ maxPages: 2 }) });
    await fixture.runner.tick(signal());
    expect(fixture.finished[0]).toMatchObject({ state: "review", code });
    expect(fixture.queue.add).not.toHaveBeenCalled();
  });
  it("reads a browser channel with its configured browser scanner; a list not scrolled to its end is partial", async () => {
    const whole = { ...scan, source: { ...scan.source, channel: "wholefoods" } };
    const browser = {
      sourceUrl: (url: string) => url,
      scan: vi.fn(async () => ({
        pages: [{ products: [product("B002CQU54Q")], cards: 1, nextPage: null, statedTotal: null }],
        complete: false,
        soldHere: true,
        archiveKeys: ["v3/brand-scans/x/search.html"],
      })),
    };
    const fixture = setup({ bodies: {}, known: ["B000000000"], browsers: { wholefoods: browser } });
    (fixture.store.claim as ReturnType<typeof vi.fn>).mockResolvedValueOnce([whole]);
    await fixture.runner.tick(signal());
    expect(fixture.lists[0]?.products.map((item) => item.listingId)).toEqual(["B002CQU54Q"]);
    expect(fixture.finished[0]).toMatchObject({ state: "partial", full: false, soldHere: true });
    expect(fixture.listings.requestRevisits).not.toHaveBeenCalled();
  });
  it("refuses a browser channel with no browser configured, as a Review with a clear code", async () => {
    const whole = { ...scan, source: { ...scan.source, channel: "wholefoods" } };
    const fixture = setup({ bodies: {}, channel: "wholefoods", capture: "browser" });
    (fixture.store.claim as ReturnType<typeof vi.fn>).mockResolvedValueOnce([whole]);
    await fixture.runner.tick(signal());
    expect(fixture.finished[0]).toMatchObject({
      state: "review",
      code: "BRAND_SCAN.BROWSER_NOT_CONFIGURED",
    });
  });
});
