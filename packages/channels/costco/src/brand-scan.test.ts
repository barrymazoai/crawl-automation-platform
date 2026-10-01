import { readFileSync } from "node:fs";
import {
  sha256,
  type BrowserPage,
  type BrowserRead,
  type ObjectStore,
} from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { CostcoBrandScan } from "./brand-scan.js";
import { costcoBrandSearchUrl } from "./address.js";
import { parseCostcoListing } from "./listing.js";
import { COSTCO_STORE } from "./store.js";
import { COSTCO_SCAN_DEFAULTS } from "./scan-settings.js";

const html = readFileSync(new URL("./fixtures/listing.html", import.meta.url), "utf8");
const header =
  '<button data-testid="Button_locationselector_WarehouseSelector--submit">Southlake</button>';
const empty = `<html><body>${header}<main>No results found</main></body></html>`;
const sourceUrl = costcoBrandSearchUrl({
  category: "vitamins-herbals-dietary-supplements",
  brand: "Example Brand",
});
const request = { scanId: "costco-scan", sourceUrl };
const signal = () => AbortSignal.timeout(5_000);
const page = (
  body: string,
  scroll: BrowserPage["scroll"] = { rounds: 3, ended: "stable" },
): BrowserPage => ({ url: sourceUrl, html: body, status: 200, ready: true, scroll });

function setup(body = html, scroll?: BrowserPage["scroll"]) {
  const data = new Map<string, Uint8Array>();
  const remote: ObjectStore = {
    read: async (key) => data.get(key) ?? null,
    create: async (key, bytes) => {
      if (data.has(key)) {
        return "exists";
      }
      data.set(key, Buffer.from(bytes));
      return "created";
    },
  };
  const browser = {
    provider: "ego-lite/2",
    read: vi.fn(async (_request: BrowserRead, _signal: AbortSignal) => page(body, scroll)),
  };
  return { data, browser, scanner: new CostcoBrandScan({ browser, remote }) };
}

describe("Costco drawn listing", () => {
  it("reads tile IDs in page order, deduplicates and excludes banner links", () => {
    const result = parseCostcoListing(html, COSTCO_STORE);
    expect(result.page.products.map((product) => product.listingId)).toEqual([
      "100029983",
      "4000100002",
    ]);
    expect(result.page).toMatchObject({ cards: 2, statedTotal: 2, nextPage: null });
  });
  it("rejects mismatched tile identity and empty/loading pages", () => {
    expect(() =>
      parseCostcoListing(html.replace("ProductTile_100029983", "ProductTile_999"), COSTCO_STORE),
    ).toThrow();
    expect(() =>
      parseCostcoListing(`<html>${header}<main>Loading…</main></html>`, COSTCO_STORE),
    ).toThrow();
  });
  it("refuses a visible tile without a product link instead of certifying a partial list", () => {
    expect(() =>
      parseCostcoListing(html.replaceAll(".product.100029983.html", ".html"), COSTCO_STORE),
    ).toThrowError(expect.objectContaining({ code: "BRAND_SCAN.TILE_IDENTITY" }));
  });
  it("archives byte-exact before parsing, with warehouse, hash and scroll proof; reuses on repeat", async () => {
    const { data, browser, scanner } = setup();
    expect(await scanner.scan(request, signal())).toMatchObject({ complete: true, soldHere: true });
    const key = "v3/brand-scans/costco-scan/search.html";
    expect(data.get(key)).toEqual(Buffer.from(html));
    expect(
      JSON.parse(Buffer.from(data.get(key.replace(".html", ".record.json")) ?? []).toString()),
    ).toMatchObject({
      storeId: "669",
      sha256: sha256(Buffer.from(html)),
      byteSize: Buffer.byteLength(html),
      scroll: { ended: "stable" },
    });
    await scanner.scan(request, signal());
    expect(browser.read).toHaveBeenCalledOnce();
    expect(browser.read.mock.calls[0]?.[0]).toMatchObject({
      scroll: {
        pressDelayMs: { min: 4000, max: 8000 },
        moreTexts: expect.arrayContaining(["load more", "next"]),
      },
    });
  });
  it("archives even a page that fails parsing", async () => {
    const { scanner, data } = setup("<main>Loading</main>");
    await expect(scanner.scan(request, signal())).rejects.toMatchObject({
      code: "COSTCO.LISTING_UNVERIFIED",
    });
    expect(data.get("v3/brand-scans/costco-scan/search.html")).toEqual(
      Buffer.from("<main>Loading</main>"),
    );
  });
  it("treats exactly 24 tiles and no more control as complete at a stable end", async () => {
    const tiles = Array.from(
      { length: 24 },
      (_, index) =>
        `<div data-testid="ProductTile_${index + 1}"><a href="/x.product.${index + 1}.html">X</a></div>`,
    ).join("");
    const { scanner } = setup(`<html>${header}<main>24 results${tiles}</main></html>`);
    const result = await scanner.scan(request, signal());
    expect(result.complete).toBe(true);
    expect(result.pages[0]?.products).toHaveLength(24);
  });
  it("retains observed links when a list shrinks and requests cool-down", async () => {
    const retained = '<a href="/x.product.100029983.html">X</a>';
    const { scanner, browser } = setup(empty, {
      rounds: 2,
      ended: "broken",
      seenCount: 1,
      finalCount: 0,
      missingCount: 1,
      observedItems: [{ href: "/x.product.100029983.html", html: retained }],
    });
    expect(await scanner.scan(request, signal())).toMatchObject({
      complete: false,
      soldHere: true,
      cooldownRequested: true,
      pages: [{ products: [{ listingId: "100029983" }] }],
    });
    expect(browser.read).toHaveBeenCalledOnce();
  });
  it("requires a healthy canary before reporting an empty brand", async () => {
    const { scanner, browser } = setup(empty);
    browser.read.mockResolvedValueOnce(page(empty)).mockResolvedValueOnce(page(html));
    expect(await scanner.scan(request, signal())).toMatchObject({
      complete: true,
      soldHere: false,
      archiveKeys: [
        "v3/brand-scans/costco-scan/search.html",
        "v3/brand-scans/costco-scan/canary.html",
      ],
    });
    expect(browser.read.mock.calls[1]?.[0]).toMatchObject({
      url: COSTCO_SCAN_DEFAULTS.canaryUrl,
      scroll: { moreTexts: [], maxRounds: 3 },
    });
  });
  it.each([empty, "<main>Loading</main>"])(
    "refuses an unhealthy canary without repeating it",
    async (canary) => {
      const { scanner, browser } = setup(empty);
      browser.read.mockResolvedValueOnce(page(empty)).mockResolvedValueOnce(page(canary));
      await expect(scanner.scan(request, signal())).rejects.toMatchObject({
        code: "COSTCO.SEARCH_THROTTLED",
        details: { cooldownRequested: true },
      });
      await expect(scanner.scan(request, signal())).rejects.toMatchObject({
        code: "COSTCO.SEARCH_THROTTLED",
      });
      expect(browser.read).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["capped", "broken"] as const)("keeps %s lists partial", async (ended) => {
    expect(await setup(html, { rounds: 60, ended }).scanner.scan(request, signal())).toMatchObject({
      complete: false,
      soldHere: true,
    });
  });
  it("does not certify readiness failures and never repeats an uncertain archive", async () => {
    const { scanner, browser, data } = setup();
    browser.read.mockResolvedValueOnce({ ...page(html), ready: false });
    expect(await scanner.scan(request, signal())).toMatchObject({ complete: false });
    data.delete("v3/brand-scans/costco-scan/search.record.json");
    await expect(scanner.scan(request, signal())).rejects.toMatchObject({
      code: "BRAND_SCAN.ARCHIVE_UNVERIFIED",
    });
    expect(browser.read).toHaveBeenCalledOnce();
  });
  it("refuses another warehouse even when the empty-search canary is healthy", async () => {
    const { scanner, browser } = setup(empty.replace("Southlake", "Seattle"));
    await expect(scanner.scan(request, signal())).rejects.toMatchObject({
      code: "COSTCO.STORE_MISMATCH",
    });
    expect(browser.read).toHaveBeenCalledOnce();
  });
});
