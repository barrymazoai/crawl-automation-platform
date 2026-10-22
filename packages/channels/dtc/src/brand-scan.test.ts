import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DtcBrandScan } from "./brand-scan.js";
import { dtcSitePolicy } from "./site-policy.js";
import type { DtcCatalogRead } from "./catalog-pages.js";

const corpus = fileURLToPath(
  new URL("../../../../tools/diag-corpus/round9/catalog/", import.meta.url),
);
const retained = (name: string) => readFileSync(`${corpus}/${name}.page.html`, "utf8");
const hasCorpus = existsSync(`${corpus}/sambucol.page.html`);
const signal = () => AbortSignal.timeout(5000);
const site = dtcSitePolicy({
  siteKey: "sambucolusa.com",
  platform: "shopify",
  catalogUrl: "https://sambucolusa.com/collections/all",
});

function drawn(request: DtcCatalogRead, html: string) {
  return {
    url: request.url,
    status: 200,
    ready: true as const,
    archiveKey: `retained-${request.position}.html`,
    scroll: { rounds: 0, ended: "none" as const },
    html,
  };
}

describe("Shopify products.json brand scan", () => {
  it.skipIf(!hasCorpus)("reads Sambucol's 22 retained products without a theme grid", async () => {
    const read = vi.fn(async (request: DtcCatalogRead) => drawn(request, retained("sambucol")));
    const result = await new DtcBrandScan({ pages: { read }, sites: [site] }).scan(
      { scanId: "sambucol", sourceUrl: site.catalogUrl ?? "" },
      signal(),
    );
    expect(read.mock.calls.map(([request]) => request.url)).toEqual([
      "https://sambucolusa.com/collections/all/products.json?limit=250&page=1",
    ]);
    expect(result).toMatchObject({
      complete: true,
      stopped: "end",
      archiveKeys: ["retained-1.html"],
    });
    expect(result.pages[0]?.products).toHaveLength(22);
    expect(result.pages[0]?.products[0]).toMatchObject({
      productId: "364217073700",
      url: "https://sambucolusa.com/products/black-elderberry-syrup-small-4-oz",
      brandEvidence: { observedBrand: "Sambucol", status: "site-brand" },
    });
  });

  it.skipIf(!hasCorpus)(
    "uses the all collection for Kate Farms' pages/shop-all source",
    async () => {
      const kate = dtcSitePolicy({
        siteKey: "shop.katefarms.com",
        platform: "shopify",
        catalogUrl: "https://shop.katefarms.com/pages/shop-all",
      });
      const read = vi.fn(async (request: DtcCatalogRead) => drawn(request, retained("katefarms")));
      const result = await new DtcBrandScan({ pages: { read }, sites: [kate] }).scan(
        { scanId: "kate", sourceUrl: kate.catalogUrl ?? "" },
        signal(),
      );
      expect(read.mock.calls[0]?.[0].url).toBe(
        "https://shop.katefarms.com/collections/all/products.json?limit=250&page=1",
      );
      expect(result.sourceUrl).toBe(kate.catalogUrl);
      expect(result.pages[0]?.products).toHaveLength(19);
    },
  );

  it.skipIf(!hasCorpus)(
    "ends Jarrow at 104 (<250) while its retained page 2 is empty",
    async () => {
      const jarrow = dtcSitePolicy({
        siteKey: "jarrow.com",
        platform: "shopify",
        catalogUrl: "https://jarrow.com/collections/all",
      });
      const read = vi.fn(async (request: DtcCatalogRead) => drawn(request, retained("jarrow")));
      const result = await new DtcBrandScan({ pages: { read }, sites: [jarrow] }).scan(
        { scanId: "jarrow", sourceUrl: jarrow.catalogUrl ?? "" },
        signal(),
      );
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0]?.products).toHaveLength(104);
      expect(read).toHaveBeenCalledOnce();
    },
  );

  it("keeps a 250-product page cap partial and rejects an identical next page", async () => {
    const products = Array.from({ length: 250 }, (_, index) => ({
      id: index + 1,
      handle: `product-${index + 1}`,
      title: `Product ${index + 1}`,
      vendor: "Sambucol",
    }));
    const read = async (request: DtcCatalogRead) => drawn(request, JSON.stringify({ products }));
    const scan = new DtcBrandScan({ pages: { read }, sites: [site], maxPages: 1 });
    expect(
      await scan.scan({ scanId: "cap", sourceUrl: site.catalogUrl ?? "" }, signal()),
    ).toMatchObject({ complete: false, stopped: "page_limit" });
    await expect(
      new DtcBrandScan({ pages: { read }, sites: [site] }).scan(
        { scanId: "repeat", sourceUrl: site.catalogUrl ?? "" },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "BRAND_SCAN.PAGINATION" });
  });

  it("rejects a non-collection multi-brand source before reading", async () => {
    const multi = dtcSitePolicy({
      siteKey: "shop.example",
      kind: "multi-brand",
      platform: "shopify",
      brands: [{ brand: "Alpha", catalogUrl: "https://shop.example/pages/alpha" }],
    });
    const read = vi.fn();
    await expect(
      new DtcBrandScan({ pages: { read }, sites: [multi] }).scan(
        { scanId: "scope", sourceUrl: "https://shop.example/pages/alpha" },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "DTC.CATALOG_SCOPE_REQUIRED" });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps a collection source with a trailing slash and query scoped to that collection", async () => {
    const scoped = dtcSitePolicy({
      siteKey: "shop.example",
      kind: "multi-brand",
      platform: "shopify",
      brands: [
        { brand: "Alpha", catalogUrl: "https://shop.example/collections/alpha/?sort_by=title" },
      ],
    });
    const read = vi.fn(async (request: DtcCatalogRead) =>
      drawn(request, '{"products":[{"id":1,"handle":"first","title":"First","vendor":"Alpha"}]}'),
    );
    const result = await new DtcBrandScan({ pages: { read }, sites: [scoped] }).scan(
      { scanId: "query", sourceUrl: "https://shop.example/collections/alpha/?sort_by=title" },
      signal(),
    );
    expect(read.mock.calls[0]?.[0].url).toBe(
      "https://shop.example/collections/alpha/products.json?limit=250&page=1",
    );
    expect(result.pages[0]?.products[0]).toMatchObject({ brand: "Alpha", brandBasis: "page" });
  });

  it("rejects invalid retained JSON rather than treating it as an empty catalog", async () => {
    const read = async (request: DtcCatalogRead) =>
      drawn(request, "<html><body><pre>not JSON</pre></body></html>");
    await expect(
      new DtcBrandScan({ pages: { read }, sites: [site] }).scan(
        { scanId: "invalid", sourceUrl: site.catalogUrl ?? "" },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "DTC.CATALOG_JSON_INVALID" });
  });
});
