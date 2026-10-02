import { randomUUID } from "node:crypto";
import {
  BrandScanRunner,
  BrandScanService,
  BrandSourceImport,
  BrandService,
  cancelledScanResult,
  type BrandScanStore,
  type BrandStore,
  type ScanRecord,
  type ScanSource,
  type AddToQueue,
  type ScanChannel,
} from "@crawl-automation/app";
import { DtcBrandScan, createDtcAdapter, dtcSitePolicy } from "@crawl-automation/channel-dtc";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import { createLogger } from "@crawl-automation/platform";
import { expect, it, vi } from "vitest";
import { createHttpApp } from "./server.js";

const origin = "https://shop.example";
const entries = [
  { name: "Alpha", url: `${origin}/collections/alpha` },
  { name: "Beta", url: `${origin}/collections/beta` },
];
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("Missing test fixture");
  }
  return value;
}

function setup(single = false) {
  const site = dtcSitePolicy({
    siteKey: "shop.example",
    platform: "shopify",
    ...(single
      ? { catalogUrl: required(entries[0]).url }
      : {
          kind: "multi-brand" as const,
          brands: entries.map((entry) => ({ brand: entry.name, catalogUrl: entry.url })),
        }),
  });
  const adapter = createDtcAdapter([site]);
  const registry = new ChannelRegistry([adapter]);
  const log = createLogger({ name: "dtc-brand-test", level: "fatal" });
  const names = entries.map((entry) => ({ brandId: randomUUID(), name: entry.name }));
  const sources: ScanSource[] = [];
  const records: ScanRecord[] = [];
  const queued: AddToQueue[] = [];
  const now = "2026-10-02T00:00:00.000Z";
  const scanStore: BrandScanStore = {
    sources: vi.fn(async (ids) => sources.filter((source) => ids.includes(source.sourceId))),
    enabledSources: vi.fn(async () => sources.filter((source) => source.enabled)),
    request: vi.fn(async (requestId, selected) => {
      for (const source of selected) {
        if (
          !records.some(
            (scan) => scan.requestId === requestId && scan.source.sourceId === source.sourceId,
          )
        ) {
          records.push({
            scanId: randomUUID(),
            requestId,
            source: { ...source },
            revisitBatchId: randomUUID(),
            state: "queued",
            result: null,
            requestedAt: now,
            startedAt: null,
            finishedAt: null,
          });
        }
      }
      return records.filter((scan) => scan.requestId === requestId);
    }),
    claim: vi.fn(async () => records.filter((scan) => scan.state === "queued")),
    finish: vi.fn(async (scanId, result) => {
      Object.assign(records.find((scan) => scan.scanId === scanId) ?? {}, {
        result,
        state: result.state,
      });
    }),
    cancel: vi.fn(async (query) => {
      const selected = records.filter(
        (scan) => scan.state === "queued" && query.sourceIds?.includes(scan.source.sourceId),
      );
      selected.forEach((scan) =>
        Object.assign(scan, { state: "cancelled", result: cancelledScanResult() }),
      );
      return { cancelled: selected.length, cancellationRequested: 0 };
    }),
    isCancellationRequested: vi.fn(
      async (scanId) => records.find((scan) => scan.scanId === scanId)?.state === "cancelled",
    ),
    list: vi.fn(async (query) =>
      records.filter((scan) => !query.sourceId || scan.source.sourceId === query.sourceId),
    ),
    get: vi.fn(async (scanId) => records.find((scan) => scan.scanId === scanId) ?? null),
    byRequest: vi.fn(async () => null),
    revisits: vi.fn(async () => ({ requested: 0, live: 0, unlisted: {}, pending: 0 })),
    knownListings: vi.fn(async () => []),
  };
  const read = vi.fn(async (request: { url: string }) => ({
    url: request.url,
    ready: true as const,
    status: 200,
    html: '<div id="product-grid"><a href="/products/shared">Shared mineral</a></div>',
    archiveKey: `saved/${request.url.split("/").at(-1)}`,
    scroll: { rounds: 3, ended: "stable" as const },
  }));
  const scanner = new DtcBrandScan({ sites: [site], pages: { read } });
  const browsers = {
    dtc: {
      sourceUrl: (url: string) => {
        adapter.scanCapture?.(url);
        return url;
      },
      scan: scanner.scan.bind(scanner),
    },
  };
  const importer = new BrandSourceImport({
    registry,
    browsers,
    log,
    store: {
      brandNames: async () => names,
      addDisabledSources: async (rows) => {
        const before = sources.length;
        for (const row of rows) {
          if (!sources.some((source) => source.brandId === row.brandId && source.url === row.url)) {
            sources.push({
              ...row,
              sourceId: randomUUID(),
              enabled: false,
              brandName: names.find((brand) => brand.brandId === row.brandId)?.name ?? "",
            });
          }
        }
        return {
          created: sources.length - before,
          existing: rows.length - (sources.length - before),
        };
      },
    },
  });
  const brandStore = {
    findSource: vi.fn(
      async (sourceId: string) => sources.find((source) => source.sourceId === sourceId) ?? null,
    ),
    find: vi.fn(async (brandId: string) => {
      const brand = names.find((entry) => entry.brandId === brandId);
      return brand ? { id: brandId, name: brand.name } : null;
    }),
    createSource: vi.fn(async () => ({ id: randomUUID() })),
    updateSource: vi.fn(async () => ({ id: randomUUID() })),
    toggleSource: vi.fn(async (input: { sourceId: string; enabled: boolean }) => {
      const source = required(sources.find((entry) => entry.sourceId === input.sourceId));
      source.enabled = input.enabled;
      return { ...source, id: source.sourceId };
    }),
  } as unknown as BrandStore;
  const service = new BrandScanService({
    store: scanStore,
    registry,
    browsers,
    log,
    enabled: true,
  });
  const unused = {} as never;
  const app = createHttpApp({
    runs: unused,
    queue: unused,
    reviews: unused,
    products: unused,
    originals: unused,
    history: unused,
    resources: unused,
    fleet: unused,
    listingStates: unused,
    brands: new BrandService({ brands: brandStore, registry, log }),
    brandScans: service,
    brandSources: importer,
  });
  const runner = new BrandScanRunner({
    store: scanStore,
    registry,
    browsers,
    log,
    pages: { read: vi.fn() },
    listings: { requestRevisits: vi.fn() },
    queue: {
      add: vi.fn(async (input) => {
        queued.push(input);
        return { added: input.products.length };
      }),
    },
  });
  return { app, runner, sources, records, queued, scanStore, read, names, brandStore };
}

async function importAndEnable(test: ReturnType<typeof setup>, selected = entries) {
  const response = await test.app.request(
    "/trpc/brands.importSources",
    post({ channel: "dtc", entries: selected }),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).result.data.created).toBe(selected.length);
  expect(test.sources.every((source) => !source.enabled)).toBe(true);
  for (const source of test.sources) {
    const enabled = await test.app.request(
      "/trpc/brands.toggleSource",
      post({
        requestId: randomUUID(),
        brandId: source.brandId,
        sourceId: source.sourceId,
        enabled: true,
        revision: 1,
      }),
    );
    expect(enabled.status).toBe(200);
  }
}

it("imports two catalogs via API, runs two independent scans and preserves both sources for a shared SKU", async () => {
  const test = setup();
  await importAndEnable(test);
  const input = {
    requestId: randomUUID(),
    sourceIds: test.sources.map((source) => source.sourceId),
  };
  const response = await test.app.request("/trpc/brands.scan", post(input));
  expect(response.status).toBe(200);
  const scans = (await response.json()).result.data as ScanRecord[];
  expect(scans).toHaveLength(2);
  expect(scans.map((scan) => scan.source.url)).toEqual(entries.map((entry) => entry.url));
  await test.app.request("/trpc/brands.scan", post(input));
  expect(test.records).toHaveLength(2);
  await test.runner.tick(AbortSignal.timeout(5000));
  expect(test.read.mock.calls.map(([request]) => request.url)).toEqual(
    entries.map((entry) => entry.url),
  );
  expect(test.queued).toHaveLength(2);
  expect(test.queued.map((batch) => batch.batchId)).toEqual(scans.map((scan) => scan.scanId));
  expect(test.queued.map((batch) => batch.products[0]?.sourceId)).toEqual(input.sourceIds);
  expect(new Set(test.queued.map((batch) => batch.products[0]?.listingId)).size).toBe(1);
  expect(test.records.every((scan) => scan.result?.queued === 1 && scan.state === "complete")).toBe(
    true,
  );
  const query = encodeURIComponent(JSON.stringify({ sourceId: input.sourceIds[0] }));
  const report = await test.app.request(`/trpc/brands.scans?input=${query}`);
  expect((await report.json()).result.data).toHaveLength(1);
});

it("cancels only the selected brand source through the API", async () => {
  const test = setup();
  await importAndEnable(test);
  await test.app.request("/trpc/brands.scan", post({ requestId: randomUUID(), channel: "dtc" }));
  const sourceIds = [required(test.sources[0]).sourceId];
  const cancelled = await test.app.request("/trpc/brands.cancelScans", post({ sourceIds }));
  expect((await cancelled.json()).result.data).toEqual({ cancelled: 1, cancellationRequested: 0 });
  expect(test.scanStore.cancel).toHaveBeenCalledWith({ sourceIds });
  await test.runner.tick(AbortSignal.timeout(5000));
  expect(test.records.map((scan) => scan.state)).toEqual(["cancelled", "complete"]);
  expect(test.queued.map((batch) => batch.products[0]?.sourceId)).toEqual([
    required(test.sources[1]).sourceId,
  ]);
});

it("refuses wrong-brand, whole-site and unconfigured imports without enabling or creating anything", async () => {
  const test = setup();
  const invalid = [
    { name: "Alpha", url: required(entries[1]).url },
    { name: "Alpha", url: `${origin}/collections/all` },
    { name: "Unknown", url: `${origin}/collections/unknown` },
  ];
  const response = await test.app.request(
    "/trpc/brands.importSources",
    post({ channel: "dtc", entries: invalid }),
  );
  expect((await response.json()).result.data).toMatchObject({
    created: 0,
    refused: [
      { ...invalid[0], code: "DTC.BRAND_SOURCE_MISMATCH" },
      { ...invalid[1], code: "CHANNEL.URL_REJECTED" },
      { ...invalid[2], code: "CHANNEL.URL_REJECTED" },
    ],
  });
  expect(test.sources).toEqual([]);
});

it.each(["createSource", "updateSource"] as const)(
  "validates DTC %s instead of bypassing import checks",
  async (method) => {
    const test = setup();
    const input = {
      requestId: randomUUID(),
      brandId: required(test.names[0]).brandId,
      channel: "dtc",
      region: "US",
      url: required(entries[1]).url,
      ...(method === "updateSource" ? { sourceId: randomUUID(), revision: 1 } : {}),
    };
    const response = await test.app.request(`/trpc/brands.${method}`, post(input));
    expect(response.status).not.toBe(200);
    expect(test.brandStore[method]).not.toHaveBeenCalled();
  },
);

it("refuses a misbound existing source before scanning or queueing", async () => {
  const test = setup();
  await importAndEnable(test);
  required(test.sources[0]).url = required(entries[1]).url;
  const response = await test.app.request(
    "/trpc/brands.scan",
    post({
      requestId: randomUUID(),
      sourceIds: [required(test.sources[0]).sourceId],
    }),
  );
  expect(response.status).not.toBe(200);
  expect(test.scanStore.request).not.toHaveBeenCalled();
  expect(test.read).not.toHaveBeenCalled();
});

it("keeps a single-brand source's existing name, catalog and one-scan behavior", async () => {
  const test = setup(true);
  await importAndEnable(test, [required(entries[0])]);
  const response = await test.app.request(
    "/trpc/brands.scan",
    post({ requestId: randomUUID(), channel: "dtc" as ScanChannel }),
  );
  expect(response.status).toBe(200);
  await test.runner.tick(AbortSignal.timeout(5000));
  expect(test.records).toHaveLength(1);
  expect(test.queued).toHaveLength(1);
  expect(test.records[0]?.source.brandName).toBe("Alpha");
});

it("refuses enabling an existing source after its brand/catalog binding becomes invalid", async () => {
  const test = setup();
  await importAndEnable(test);
  const source = required(test.sources[0]);
  source.enabled = false;
  source.url = required(entries[1]).url;
  vi.mocked(test.brandStore.toggleSource).mockClear();
  const response = await test.app.request(
    "/trpc/brands.toggleSource",
    post({
      requestId: randomUUID(),
      brandId: source.brandId,
      sourceId: source.sourceId,
      enabled: true,
      revision: 1,
    }),
  );
  expect(response.status).not.toBe(200);
  expect(test.brandStore.toggleSource).not.toHaveBeenCalled();
  expect(source.enabled).toBe(false);
});
