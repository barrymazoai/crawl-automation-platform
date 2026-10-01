import { brandScanErrors } from "@crawl-automation/channels-core";
import { configuredDtcSites } from "@crawl-automation/channel-dtc";
import { amazonStoreSourceUrl } from "@crawl-automation/channel-amazon";
import { EgoPages, RetainedPublication, type ObjectStore } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { acceptsAddress, BrowserScanners } from "./browser-scanners.js";
import { ManagedBrowserRounds } from "./managed-rounds.js";
import { buildBrowserScanners } from "./scan-wiring.js";

function memoryStore(): ObjectStore {
  const data = new Map<string, Uint8Array>();
  return {
    read: async (key) => data.get(key) ?? null,
    create: async (key, bytes) => {
      if (data.has(key)) {
        return "exists";
      }
      data.set(key, bytes);
      return "created";
    },
  };
}

it("prepares the Whole Foods store before brand/canary reads and passes worker pacing", async () => {
  const sourceUrl = "https://www.wholefoodsmarket.com/grocery/search?k=Brand&rh=p_123%3A123";
  const canaryUrl = "https://www.wholefoodsmarket.com/grocery/search?k=365";
  const ego = new EgoPages({ cliPath: "/tmp/not-executed-ego", taskSpaceId: 1 });
  const round = vi.spyOn(ego, "round").mockResolvedValue({ shown: "10259", changed: true });
  const header =
    '<header><script type="application/json">{"storePreference":{"buid":"10259","storeName":"The Alameda"}}</script></header>';
  const page = {
    url: sourceUrl,
    status: 200,
    ready: true,
    scroll: { rounds: 3, ended: "stable" as const },
  };
  const read = vi
    .spyOn(ego, "read")
    .mockResolvedValueOnce({
      ...page,
      html: `<html><body>${header}<main>No results for Brand</main></body></html>`,
    })
    .mockResolvedValueOnce({
      ...page,
      html: `<html><body>${header}<main><a href="/grocery/product/food-b000000001">Food</a></main></body></html>`,
    });
  const scans = buildBrowserScanners({
    ego,
    rounds: new ManagedBrowserRounds(ego, async () => true),
    publication: new RetainedPublication(memoryStore(), memoryStore()),
    store: { storeId: "10259", label: "The Alameda", postalCode: "95126" },
    wholefoodsScan: { canaryUrl, pressDelayMs: { min: 5000, max: 6000 } },
  });
  expect(
    await scans.scan({ sourceUrl, scanId: "store-scan" }, new AbortController().signal),
  ).toMatchObject({ complete: true, soldHere: false });
  expect(round).toHaveBeenCalledOnce();
  expect(round.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0] ?? 0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[0]?.[0].scroll?.pressDelayMs).toEqual({ min: 5000, max: 6000 });
  expect(read.mock.calls[1]?.[0]).toMatchObject({ url: canaryUrl, scroll: { moreTexts: [] } });
});

describe("browser scan capability wiring", () => {
  it("registers the Store scanner in the actual worker composition without Whole Foods setup", async () => {
    const sourceUrl = "https://www.amazon.com/stores/page/00000000-0000-0000-0000-000000000001";
    const ego = new EgoPages({ cliPath: "/tmp/not-executed-ego", taskSpaceId: 1 });
    const round = vi.spyOn(ego, "round").mockResolvedValue({
      snapshots: [
        {
          url: sourceUrl,
          status: 200,
          tileCount: 1,
          capturedAt: "2026-09-30T00:00:00.000Z",
          html: `<html><body><nav class="Navigation__navBar__test"><a href="${sourceUrl}">Home</a></nav>
          <li class="ProductGridItem__itemOuter__test" data-asin="B000000001"></li></body></html>`,
          asins: ["B000000001"],
          navigation: [sourceUrl],
          ready: true,
          blocked: false,
          invalidTiles: false,
          more: false,
          loading: false,
          bottom: true,
        },
      ],
      proof: { rounds: 3, stableRounds: 3, noMore: true, bottom: true, ended: "stable" },
    });
    const scans = buildBrowserScanners({
      ego,
      publication: new RetainedPublication(memoryStore(), memoryStore()),
      rounds: new ManagedBrowserRounds(ego, async () => true),
      store: { storeId: "10259", label: "The Alameda", postalCode: "95126" },
    });
    const signal = new AbortController().signal;
    await scans.prepare(sourceUrl, signal);
    const result = await scans.scan({ scanId: "wired-store", sourceUrl }, signal);
    expect(result.complete).toBe(true);
    expect(result.pages[0]?.products[0]?.listingId).toBe("B000000001");
    expect(round).toHaveBeenCalledOnce();
    expect(round.mock.calls[0]?.[0]).toContain("load more Store products");
  });
  it("selects a Store URL without invoking another capability's preparation", async () => {
    const request = {
      scanId: "scan",
      sourceUrl: "https://www.amazon.com/stores/page/00000000-0000-0000-0000-000000000001",
    };
    const result = { pages: [], complete: false, soldHere: false, archiveKeys: [] };
    const scan = vi.fn(async () => result);
    const prepare = vi.fn(async () => undefined);
    const scanners = new BrowserScanners([
      { accepts: (url) => acceptsAddress([amazonStoreSourceUrl], url), scanner: { scan } },
      { accepts: () => false, scanner: { scan: vi.fn() }, prepare },
    ]);
    const signal = new AbortController().signal;
    await scanners.prepare(request.sourceUrl, signal);
    expect(await scanners.scan(request, signal)).toBe(result);
    expect(scan).toHaveBeenCalledExactlyOnceWith(request, signal);
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["https://www.amazon.com/s?k=brand", "https://www.amazon.com/dp/B000000001"])(
    "does not send Amazon search/product URL to Store capability: %s",
    async (sourceUrl) => {
      const scan = vi.fn();
      const scanners = new BrowserScanners([
        { accepts: (url) => acceptsAddress([amazonStoreSourceUrl], url), scanner: { scan } },
      ]);
      await expect(
        scanners.scan({ scanId: "scan", sourceUrl }, new AbortController().signal),
      ).rejects.toMatchObject({ code: "CHANNEL.CAPTURE_MODE_UNSUPPORTED" });
      expect(scan).not.toHaveBeenCalled();
    },
  );

  it("refuses overlapping capabilities instead of picking one silently", async () => {
    const scanner = { scan: vi.fn() };
    const scans = new BrowserScanners([
      { accepts: () => true, scanner },
      { accepts: () => true, scanner },
    ]);
    await expect(
      scans.scan(
        { scanId: "scan", sourceUrl: "https://example.com" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CHANNEL.CAPTURE_MODE_UNSUPPORTED", details: { matches: 2 } });
  });
});

it("captures configured DTC catalogs in Ego, without Whole Foods preparation", async () => {
  const sourceUrl = "https://shop.example/collections/all";
  const ego = new EgoPages({ cliPath: "/tmp/not-executed-ego", taskSpaceId: 1 });
  const read = vi.spyOn(ego, "read").mockResolvedValue({
    url: sourceUrl,
    status: 200,
    ready: true,
    html: '<main><div id="product-grid"><a href="/products/sleep">Sleep</a></div></main>',
    scroll: { rounds: 3, ended: "stable" },
  });
  const round = vi.spyOn(ego, "round").mockRejectedValue(new Error("Unexpected store preparation"));
  const scans = buildBrowserScanners({
    ego,
    publication: new RetainedPublication(memoryStore(), memoryStore()),
    rounds: new ManagedBrowserRounds(ego, async () => true),
    store: { storeId: "10259", label: "The Alameda", postalCode: "95126" },
    dtcSites: configuredDtcSites({
      sites: [{ siteKey: "shop.example", platform: "shopify", catalogUrl: sourceUrl }],
    }),
  });
  const signal = new AbortController().signal;
  await scans.prepare("https://shop.example/products/sleep", signal);
  const result = await scans.scan({ scanId: "dtc-scan", sourceUrl }, signal);
  expect(result).toMatchObject({ complete: true, soldHere: true });
  expect(result.pages[0]?.products[0]?.url).toBe("https://shop.example/products/sleep");
  expect(read).toHaveBeenCalledOnce();
  expect(round).not.toHaveBeenCalled();
});

it("routes Costco to Ego with pacing and no store switching", async () => {
  const sourceUrl = "https://www.costco.com/protein.html?refinement=brands%3DExample";
  const ego = new EgoPages({ cliPath: "/tmp/not-executed-ego", taskSpaceId: 1 });
  const read = vi.spyOn(ego, "read").mockResolvedValue({
    url: sourceUrl,
    status: 200,
    ready: true,
    html: '<html><body><button data-testid="Button_locationselector_WarehouseSelector--submit">Southlake</button><main><div data-testid="ProductTile_123"><a href="/protein.product.123.html">Protein</a></div></main></body></html>',
    scroll: { rounds: 3, ended: "stable" },
  });
  const round = vi.spyOn(ego, "round").mockRejectedValue(new Error("No store switching"));
  const scanners = buildBrowserScanners({
    ego,
    rounds: new ManagedBrowserRounds(ego, async () => true),
    publication: new RetainedPublication(memoryStore(), memoryStore()),
    store: { storeId: "10259", label: "The Alameda", postalCode: "95126" },
    costcoScan: { canaryUrl: sourceUrl, pressDelayMs: { min: 5000, max: 6000 } },
  });
  expect(
    await scanners.scan({ scanId: "costco-wiring", sourceUrl }, new AbortController().signal),
  ).toMatchObject({ complete: true, pages: [{ products: [{ listingId: "123" }] }] });
  expect(read.mock.calls[0]?.[0].scroll?.pressDelayMs).toEqual({ min: 5000, max: 6000 });
  expect(round).not.toHaveBeenCalled();
});

it("checks cancellation before store preparation or opening a browser page", async () => {
  const prepare = vi.fn();
  const scan = vi.fn();
  const scanners = new BrowserScanners([{ accepts: () => true, prepare, scanner: { scan } }]);
  const checkpoint = async () => {
    throw brandScanErrors.create("BRAND_SCAN.CANCELLED");
  };
  await expect(
    scanners.scan(
      { scanId: "cancelled", sourceUrl: "https://example.test", checkpoint },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "BRAND_SCAN.CANCELLED" });
  expect(prepare).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
});
