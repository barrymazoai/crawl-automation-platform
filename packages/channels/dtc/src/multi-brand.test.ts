import { describe, expect, it, vi } from "vitest";
import { createDtcAdapter } from "./adapter.js";
import { DtcBrandScan } from "./brand-scan.js";
import { dtcSitePolicy } from "./site-policy.js";
import type { DtcCatalogRead } from "./catalog-pages.js";
import { dtcIdentityKey } from "./identity.js";

const origin = "https://nutriessential.com";
const sourceUrl = `${origin}/collections/thorne`;
const site = dtcSitePolicy({
  siteKey: "nutriessential.com",
  kind: "multi-brand",
  platform: "shopify",
  brands: [
    { brand: "Thorne", catalogUrl: sourceUrl },
    { brand: "Metagenics", catalogUrl: `${origin}/collections/metagenics` },
  ],
});
const adapter = createDtcAdapter([site]);
const scoped = adapter.forBrandSource(sourceUrl);
const url = `${origin}/products/magnesium?variant=11`;
const signal = () => AbortSignal.timeout(5000);

function page(options: { vendor?: string; schemaBrand?: unknown; embedded?: boolean } = {}) {
  const product = {
    id: 123,
    handle: "magnesium",
    title: "Magnesium",
    vendor: options.vendor,
    variants: [{ id: 11, price: 1000, available: true }],
  };
  const schema = {
    "@type": "Product",
    productID: "123",
    name: "Magnesium",
    url,
    brand: options.schemaBrand,
    offers: { url, price: "10.00", priceCurrency: "USD" },
  };
  return {
    url,
    capturedAt: "2026-09-30T00:00:00.000Z",
    html: `<link rel="canonical" href="${origin}/products/magnesium">
      ${options.embedded === false ? "" : `<script type="application/json">${JSON.stringify(product)}</script>`}
      <script type="application/ld+json">${JSON.stringify(schema)}</script>
      <main><form action="/cart/add"><input name="id" value="11"></form></main>`,
  };
}

function listing(request: DtcCatalogRead, next?: string) {
  const product = {
    id: request.position,
    title: "Minerals",
    handle: `mineral-${request.position}`,
    vendor: "Thorne",
  };
  return {
    url: request.url,
    ready: true as const,
    status: 200,
    scroll: { rounds: 3, ended: "stable" as const },
    archiveKey: `collection-${request.position}.html`,
    html: `<div id="product-grid"><a href="/products/${product.handle}">Minerals</a></div>
      <a href="/products/unrelated">Unrelated</a>
      <script type="application/json">${JSON.stringify({ products: [product] })}</script>
      ${next ? `<a rel="next" href="${next}">Next</a>` : ""}`,
  };
}

describe("a multi-brand scan is exactly one brand's collection", () => {
  it("binds scan routing to one catalog without narrowing the shared adapter", () => {
    const otherUrl = `${origin}/collections/metagenics`;
    expect(scoped.scanCapture?.(sourceUrl)).toBe("browser");
    expect(() => scoped.scanCapture?.(otherUrl)).toThrow();
    expect(adapter.scanCapture?.(otherUrl)).toBe("browser");
  });

  it("reads only the selected collection and its next page with end proof", async () => {
    const read = vi.fn(async (request: DtcCatalogRead) =>
      listing(request, request.position === 1 ? "?page=2" : undefined),
    );
    const scan = new DtcBrandScan({ sites: [site], pages: { read } });
    const result = await scan.scan({ scanId: "thorne-only", sourceUrl }, signal());
    expect(result).toMatchObject({
      complete: true,
      stopped: "end",
      source: { brand: "Thorne", catalogUrl: sourceUrl },
    });
    expect(read.mock.calls.map(([request]) => request.url)).toEqual([
      sourceUrl,
      `${sourceUrl}?page=2`,
    ]);
    expect(result.pages.flatMap((entry) => entry.products)).toEqual([
      expect.objectContaining({
        brand: "Thorne",
        seller: site.siteKey,
        brandBasis: "page",
        url: `${origin}/products/mineral-1`,
      }),
      expect.objectContaining({
        brand: "Thorne",
        seller: site.siteKey,
        brandBasis: "page",
        url: `${origin}/products/mineral-2`,
      }),
    ]);
  });

  it.each(["/collections/metagenics", "/collections/all"])(
    "refuses pagination into %s",
    async (next) => {
      const read = vi.fn(async (request: DtcCatalogRead) => listing(request, next));
      const scan = new DtcBrandScan({ sites: [site], pages: { read } });
      await expect(scan.scan({ scanId: "bad-next", sourceUrl }, signal())).rejects.toThrow();
      expect(read).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a redirect into another configured brand collection", async () => {
    const read = vi.fn(async (request: DtcCatalogRead) => ({
      ...listing(request),
      url: `${origin}/collections/metagenics`,
    }));
    await expect(
      new DtcBrandScan({ sites: [site], pages: { read } }).scan(
        { scanId: "redirect", sourceUrl },
        signal(),
      ),
    ).rejects.toThrow();
  });

  it("keeps a collection vendor mismatch as evidence without renaming its source", async () => {
    const read = async (request: DtcCatalogRead) => {
      const drawn = listing(request);
      return { ...drawn, html: drawn.html.replace('"vendor":"Thorne"', '"vendor":"Metagenics"') };
    };
    const result = await new DtcBrandScan({ sites: [site], pages: { read } }).scan(
      { scanId: "vendor-mismatch", sourceUrl },
      signal(),
    );
    expect(result.source.brand).toBe("Thorne");
    expect(result.pages[0]?.products[0]).toMatchObject({
      brand: "Metagenics",
      brandEvidence: {
        source: { brand: "Thorne" },
        observedBrand: "Metagenics",
        status: "mismatch",
      },
    });
  });
});

describe("multi-brand product identity and brand evidence", () => {
  it("uses Shopify vendor, keeps seller separate, and leaves product/variant identity unchanged", () => {
    const parsed = scoped.parseProduct(page({ vendor: "Thorne" }));
    expect(parsed.identity).toEqual({
      listingId: dtcIdentityKey(site.siteKey, "123"),
      variantId: "11",
    });
    expect(parsed.evidence.brandRaw).toBe("Thorne");
    expect(parsed.rendered.brandEvidence).toMatchObject({
      seller: site.siteKey,
      source: { brand: "Thorne", catalogUrl: sourceUrl },
      observedBrand: "Thorne",
      status: "matched",
    });
    expect(parsed.commerce?.context).toContain(`dtc-seller:${site.siteKey}`);
    expect(
      adapter.productAddress(`${origin}/collections/thorne/products/magnesium?variant=11`),
    ).toEqual(adapter.productAddress(url));
    expect(
      adapter
        .forBrandSource(`${origin}/collections/metagenics`)
        .parseProduct(page({ vendor: "Thorne" })).identity,
    ).toEqual(parsed.identity);
  });

  it.each(["Thorne", { "@type": "Brand", name: "Thorne" }])(
    "uses JSON-LD brand %j when vendor is absent",
    (schemaBrand) => {
      for (const embedded of [true, false]) {
        expect(scoped.parseProduct(page({ schemaBrand, embedded })).evidence.brandRaw).toBe(
          "Thorne",
        );
      }
    },
  );

  it("retains the observed brand and source mismatch through projection replay", () => {
    const parsed = scoped.parseProduct(page({ vendor: "Metagenics" }));
    expect(parsed.evidence.brandRaw).toBe("Metagenics");
    expect(parsed.evidence.warnings).toContain("DTC.BRAND_MISMATCH");
    const projection = scoped.planning?.projection(parsed.rendered);
    expect(projection).toMatchObject({
      brandEvidence: {
        source: { brand: "Thorne", catalogUrl: sourceUrl },
        observedBrand: "Metagenics",
        status: "mismatch",
      },
    });
    expect(scoped.planning?.read(projection, url, parsed.identity).evidence).toEqual(
      parsed.evidence,
    );
    expect(adapter.planning?.read(projection, url, parsed.identity).evidence).toEqual(
      parsed.evidence,
    );
  });

  it("does not fill missing page brand from the retailer or the brand source", () => {
    const parsed = scoped.parseProduct(page());
    expect(parsed.evidence.brandRaw).toBeNull();
    expect(parsed.evidence.warnings).toContain("DTC.BRAND_UNVERIFIED");
    expect(parsed.rendered.brandEvidence).toMatchObject({
      source: { brand: "Thorne" },
      status: "unverified",
    });
  });

  it("ignores another product's JSON-LD brand rather than failing a valid Shopify product", () => {
    const retained = page({ schemaBrand: "Metagenics" });
    retained.html = retained.html.replace(`"url":"${url}"`, `"url":"${origin}/products/other"`);
    const parsed = scoped.parseProduct(retained);
    expect(parsed.evidence.brandRaw).toBeNull();
    expect(parsed.evidence.warnings).toContain("DTC.BRAND_UNVERIFIED");
  });

  it("marks an unobserved catalog vendor as source-derived", async () => {
    const read = async (request: DtcCatalogRead) => {
      const drawn = listing(request);
      return { ...drawn, html: drawn.html.replace(',"vendor":"Thorne"', "") };
    };
    const result = await new DtcBrandScan({ sites: [site], pages: { read } }).scan(
      { scanId: "source-derived", sourceUrl },
      signal(),
    );
    expect(result.pages[0]?.products[0]).toMatchObject({
      brand: "Thorne",
      brandBasis: "source",
      brandEvidence: { observedBrand: null },
    });
  });

  it("does not guess a source for an independently submitted product URL", () => {
    expect(adapter.parseProduct(page({ vendor: "Thorne" })).rendered.brandEvidence).toMatchObject({
      source: null,
      observedBrand: "Thorne",
      status: "unscoped",
    });
  });

  it("rejects a retained projection relabelled as matching or bound to another source", () => {
    const parsed = scoped.parseProduct(page({ vendor: "Metagenics" }));
    const projection = {
      codec: "dtc-product/2",
      evidence: parsed.evidence,
      brandEvidence: parsed.rendered.brandEvidence,
    };
    expect(() =>
      scoped.planning?.read(
        { ...projection, brandEvidence: { ...projection.brandEvidence, status: "matched" } },
        url,
        parsed.identity,
      ),
    ).toThrow();
    expect(() =>
      adapter
        .forBrandSource(`${origin}/collections/metagenics`)
        .planning?.read(projection, url, parsed.identity),
    ).toThrow();
    expect(() => scoped.planning?.read(parsed.evidence, url, parsed.identity)).toThrow();
  });
});
