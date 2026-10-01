import { describe, expect, it, vi } from "vitest";
import { DtcBrandScan } from "./brand-scan.js";
import { dtcSitePolicy } from "./site-policy.js";
import type { DtcCatalogRead } from "./catalog-pages.js";

const site = dtcSitePolicy({
  siteKey: "shop.example",
  platform: "shopify",
  catalogUrl: "https://shop.example/collections/all",
});
const request = { scanId: "scan-test", sourceUrl: site.catalogUrl ?? "" };
function drawn(
  position: number,
  options: { next?: string; ended?: "stable" | "capped" | "broken"; empty?: boolean } = {},
) {
  return {
    url: request.sourceUrl + (position > 1 ? `?page=${position}` : ""),
    status: 200,
    ready: true as const,
    archiveKey: `retained-${position}.html`,
    scroll: { rounds: 3, ended: options.ended ?? "stable" },
    html: options.empty
      ? '<div data-catalog-empty="true"></div>'
      : `<div id="product-grid"><a href="/products/product-${position}">Product ${position}</a></div>${options.next ? `<a rel="next" href="${options.next}">Next</a>` : ""}`,
  };
}
const signal = () => AbortSignal.timeout(5000);

describe("DTC browser catalog completion", () => {
  it("counts product links inside every configured catalog root for stable scrolling", () => {
    expect(
      site.scroll.itemSelector.split(",").every((selector) => selector.trim().includes(" a")),
    ).toBe(true);
  });
  it("refuses to call a scan starting at page 2 complete", async () => {
    const read = vi.fn(async () => drawn(2));
    const scan = new DtcBrandScan({ pages: { read }, sites: [site] });
    await expect(
      scan.scan({ ...request, sourceUrl: `${request.sourceUrl}?page=2` }, signal()),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("walks actual next links and proves a stable final page", async () => {
    const read = vi.fn(async ({ position }: DtcCatalogRead) =>
      drawn(position, position === 1 ? { next: "?page=2" } : {}),
    );
    const scan = new DtcBrandScan({ pages: { read }, sites: [site] });
    const result = await scan.scan(request, signal());
    expect(result.complete).toBe(true);
    expect(result.pages).toHaveLength(2);
    expect(result.archiveKeys).toEqual(["retained-1.html", "retained-2.html"]);
    expect(read.mock.calls[1]?.[0].url).toBe(`${request.sourceUrl}?page=2`);
  });
  it.each(["capped", "broken"] as const)(
    "keeps %s scrolling partial even without a next link",
    async (ended) => {
      const scan = new DtcBrandScan({
        pages: { read: async () => drawn(1, { ended }) },
        sites: [site],
      });
      expect(await scan.scan(request, signal())).toMatchObject({
        complete: false,
        stopped: "scroll_limit",
      });
    },
  );
  it("keeps a page cap partial", async () => {
    const scan = new DtcBrandScan({
      pages: { read: async () => drawn(1, { next: "?page=2" }) },
      sites: [site],
      maxPages: 1,
    });
    expect(await scan.scan(request, signal())).toMatchObject({
      complete: false,
      stopped: "page_limit",
    });
  });
  it("refuses pagination cycles", async () => {
    const scan = new DtcBrandScan({
      pages: { read: async () => drawn(1, { next: request.sourceUrl }) },
      sites: [site],
    });
    await expect(scan.scan(request, signal())).rejects.toThrow();
  });
  it("refuses repeated products behind a new page query", async () => {
    const scan = new DtcBrandScan({
      pages: { read: async () => drawn(1, { next: "?page=2" }) },
      sites: [site],
    });
    await expect(scan.scan(request, signal())).rejects.toThrow();
  });
  it("refuses a next link outside the chosen catalog", async () => {
    const scan = new DtcBrandScan({
      pages: { read: async () => drawn(1, { next: "/collections/elsewhere" }) },
      sites: [site],
    });
    await expect(scan.scan(request, signal())).rejects.toThrow();
  });
  it("accepts an explicitly empty stable catalog", async () => {
    const scan = new DtcBrandScan({
      pages: { read: async () => drawn(1, { empty: true }) },
      sites: [site],
    });
    const result = await scan.scan(request, signal());
    expect(result.complete).toBe(true);
    expect(result.pages[0]?.products).toEqual([]);
  });
  it("does not call an unreadable page an empty catalog", async () => {
    const scan = new DtcBrandScan({
      pages: { read: async () => ({ ...drawn(1), html: "<main>Loading</main>" }) },
      sites: [site],
    });
    await expect(scan.scan(request, signal())).rejects.toThrow();
  });
});
