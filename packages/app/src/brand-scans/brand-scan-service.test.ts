import { Writable } from "node:stream";
import { ChannelRegistry, type ChannelAdapter } from "@crawl-automation/channels-core";
import { createLogger } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { BrandSourceImport, type BrandSourceImportStore } from "../brands/source-import.js";
import { BrandScanService } from "./brand-scan-service.js";
import type { BrandScanStore } from "./ports.js";
import type { ScanSource } from "./scan-model.js";

const log = createLogger({
  name: "test",
  destination: new Writable({ write: (_c, _e, done) => done() }),
});
const ORIGIN = "https://www.gnc.com";

/** A GNC-like adapter whose brand sources are `/brands/<slug>/`. */
const gnc: ChannelAdapter = {
  id: "gnc",
  captureModes: ["http"],
  httpPolicy: { origins: [ORIGIN], maxBytes: 1_000, timeoutMs: 1_000 },
  brandScan: {
    sourceUrl: (url) => {
      const slug = new URL(url).pathname.match(/^\/brands\/([a-z-]+)\/?$/)?.[1];
      if (!slug) {
        throw Object.assign(new Error("not a brand"), { code: "BRAND_SCAN.URL" });
      }
      return `${ORIGIN}/brands/${slug}/`;
    },
    pageUrl: (source) => source,
    answer: "html",
    maxPages: 1,
    maxBytes: 1_000,
    parsePage: () => ({ products: [], cards: 0, nextPage: null, statedTotal: null }),
    complete: () => true,
  },
  productAddress: () => ({ url: ORIGIN, listingId: "x", variantId: null }),
  parseProduct: () => {
    throw new Error("not used");
  },
};
const registry = new ChannelRegistry([gnc]);

const source = (overrides: Partial<ScanSource> = {}): ScanSource => ({
  sourceId: "11111111-1111-4111-8111-111111111111",
  brandId: "22222222-2222-4222-8222-222222222222",
  brandName: "Nordic Naturals",
  channel: "gnc",
  url: `${ORIGIN}/brands/nordic-naturals`,
  enabled: true,
  ...overrides,
});

function service(sources: ScanSource[]) {
  const store = {
    sources: vi.fn(async (ids: readonly string[]) =>
      sources.filter((item) => ids.includes(item.sourceId)),
    ),
    enabledSources: vi.fn(async () => sources.filter((item) => item.enabled)),
    request: vi.fn(async (_requestId: string, requested: readonly ScanSource[]) => requested),
  } as unknown as BrandScanStore & { request: ReturnType<typeof vi.fn> };
  return {
    store,
    scans: new BrandScanService({ store, registry, browsers: {}, log, enabled: true }),
  };
}

const requestId = "33333333-3333-4333-8333-333333333333";

describe("brand scan requests", () => {
  it("scans every enabled source of a channel, each URL in the reader's own form", async () => {
    const { store, scans } = service([
      source(),
      source({ sourceId: "44444444-4444-4444-8444-444444444444", enabled: false }),
    ]);
    await scans.request({ requestId, channel: "gnc" });
    expect(store.request).toHaveBeenCalledWith(requestId, [
      expect.objectContaining({ url: `${ORIGIN}/brands/nordic-naturals/` }),
    ]);
  });

  it.each([
    [[source({ enabled: false })], "BRAND_SCAN.SOURCE_DISABLED"],
    [[], "BRAND.SOURCE_NOT_FOUND"],
  ])("refuses what cannot be scanned (%#)", async (sources, code) => {
    const { scans } = service(sources);
    await expect(
      scans.request({ requestId, sourceIds: [source().sourceId] }),
    ).rejects.toMatchObject({ code });
  });

  it("refuses a browser channel when no browser is configured here", async () => {
    const { scans } = service([source({ channel: "wholefoods" })]);
    await expect(
      scans.request({ requestId, sourceIds: [source().sourceId] }),
    ).rejects.toMatchObject({
      code: "BRAND_SCAN.BROWSER_NOT_CONFIGURED",
    });
  });
});

describe("brand source import", () => {
  it("adds exact name matches as disabled sources, and returns loose, missing and refused entries", async () => {
    const store: BrandSourceImportStore = {
      brandNames: async () => [
        { brandId: "a", name: "Nordic Naturals" },
        { brandId: "b", name: "GNC Mega Men" },
      ],
      addDisabledSources: vi.fn(async (rows) => ({ created: rows.length, existing: 0 })),
    };
    const importer = new BrandSourceImport({ store, registry, browsers: {}, log });
    const result = await importer.import({
      channel: "gnc",
      entries: [
        { name: "nordic naturals", url: `${ORIGIN}/brands/nordic-naturals/` },
        { name: "GNC Mega Men®", url: `${ORIGIN}/brands/gnc-mega-men/` },
        { name: "HTLT", url: `${ORIGIN}/brands/htlt/` },
        { name: "Nordic Naturals", url: `${ORIGIN}/vitamin-d/877080.html` },
      ],
    });
    expect(store.addDisabledSources).toHaveBeenCalledWith([
      { brandId: "a", channel: "gnc", url: `${ORIGIN}/brands/nordic-naturals/` },
    ]);
    expect(result).toMatchObject({
      created: 1,
      looseMatches: [{ name: "GNC Mega Men®", candidates: ["GNC Mega Men"] }],
      unmatched: [{ name: "HTLT" }],
      refused: [{ name: "Nordic Naturals", code: "BRAND_SCAN.URL" }],
    });
  });
});
