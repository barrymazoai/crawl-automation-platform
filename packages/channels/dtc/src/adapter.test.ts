import { describe, expect, it } from "vitest";
import {
  ChannelRegistry,
  identitySighting,
  readPlatformCatalog,
} from "@crawl-automation/channels-core";
import { dtcIdentityKey } from "./identity.js";
import { createDtcAdapter, dtcAdapter } from "./adapter.js";
import { dtcDocument } from "./product.js";
import { dtcSitePolicy } from "./site-policy.js";

const site = dtcSitePolicy({
  siteKey: "shop.example",
  platform: "shopify",
  catalogUrl: "https://shop.example/collections/all",
});
const adapter = createDtcAdapter([site]);
const url = "https://shop.example/products/sleep?variant=11";
const facts =
  "<section><h2>Supplement Facts</h2><p>Serving Size: 2 capsules</p><p>Magnesium 100 mg</p><p>Other Ingredients: cellulose.</p></section>";
const data = {
  id: 123,
  title: "Sleep",
  handle: "sleep",
  variants: [{ id: 11, price: 1000, available: true, title: "One bottle" }],
  description: facts,
  images: ["/front.jpg"],
};
function page(options: { data?: object; selection?: string; extra?: string } = {}) {
  return {
    url,
    capturedAt: "2026-09-10T00:00:00.000Z",
    html: `<html><head>
    <link rel="canonical" href="https://shop.example/products/sleep">
    <meta property="product:price:currency" content="USD"></head><body>
    <script type="application/json">${JSON.stringify(options.data ?? data)}</script>
    <product-info><form action="/cart/add"><input name="id" value="${options.selection ?? "11"}"></form>
    ${facts}<details><summary>Label</summary><img data-src="/label.jpg"></details>
    <product-recommendations><img src="/another-product.jpg"></product-recommendations></product-info>
    ${options.extra ?? ""}</body></html>`,
  };
}

describe("DTC adapter contracts (small synthetic boundary cases, not saved-page evidence)", () => {
  it("registers exactly one browser-only adapter and refuses HTTP", () => {
    const registry = new ChannelRegistry([adapter]);
    expect(registry.channels()).toEqual(["dtc"]);
    expect(registry.forCapture("dtc", "browser")).toBe(adapter);
    expect(() => registry.forCapture("dtc", "http")).toThrow();
    expect(adapter.brandScan).toBeUndefined();
    expect(adapter.scanCapture?.(site.catalogUrl ?? "")).toBe("browser");
    expect(() => adapter.scanCapture?.(url)).toThrow();
  });
  it("does not enable the requested first site before its browser check", () => {
    expect(() =>
      dtcAdapter.parseProduct({ ...page(), url: "https://nutriessential.com/products/sleep" }),
    ).toThrowError();
    expect(dtcAdapter.httpPolicy.origins).toEqual([]);
  });
  it("namespaces product IDs by site and keeps variant IDs", () => {
    const parsed = adapter.parseProduct(page());
    expect(parsed.identity).toEqual({
      listingId: dtcIdentityKey("shop.example", "123"),
      variantId: "11",
    });
    expect(parsed.evidence.brandRaw).toBe("shop.example");
    expect(parsed.commerce).toMatchObject({
      price: "10.00",
      currency: "USD",
      availability: "InStock",
    });
    // Since step 2 the page's own selected variant is this task; only the others are handed back for discovery.
    expect(parsed.variants).toEqual([]);
    expect(parsed.evidence.variants[0]?.variantId).toBe("11");
  });
  it("takes gallery and accordion images without recommendations", () => {
    const images = adapter.parseProduct(page()).evidence.imageCandidates;
    const urls = images.map((image) => image.url);
    expect(urls).toEqual(["https://shop.example/front.jpg", "https://shop.example/label.jpg"]);
    expect(images.every((image) => image.variantId === "11")).toBe(true);
  });
  it.each([
    [true, "InStock"],
    [false, "OutOfStock"],
  ])("maps selected Shopify stock %s to %s", (available, expected) => {
    const product = { ...data, variants: [{ ...data.variants[0], available }] };
    expect(adapter.parseProduct(page({ data: product })).commerce?.availability).toBe(expected);
  });
  it("keeps observed description label images and variant-featured images", () => {
    const product = {
      ...data,
      description: `${facts}<img src="/description-label.png">`,
      variants: [{ ...data.variants[0], featured_image: { src: "/variant.jpg" } }],
    };
    const images = adapter.parseProduct(page({ data: product })).evidence.imageCandidates;
    expect(images.some((image) => image.url.endsWith("/description-label.png"))).toBe(true);
    expect(images.find((image) => image.url.endsWith("/variant.jpg"))).toMatchObject({
      variantId: "11",
      basis: "variant-featured",
    });
  });
  it("keeps identical native IDs on two sites separate", () => {
    expect(dtcIdentityKey("shop.example", "123")).not.toBe(dtcIdentityKey("other.example", "123"));
    expect(dtcIdentityKey("a-b", "c")).not.toBe(dtcIdentityKey("a", "b-c"));
  });
  it("keeps the site brand on a single-brand site even when its vendor differs", () => {
    const parsed = adapter.parseProduct(page({ data: { ...data, vendor: "Supplier" } }));
    expect(parsed.evidence.brandRaw).toBe(site.siteKey);
    expect(parsed.evidence.warnings).not.toContain("DTC.BRAND_MISMATCH");
  });
  it("uses complete serving/amount/ingredients facts and validates its projection", () => {
    const parsed = adapter.parseProduct(page());
    expect(parsed.facts.complete).toBe(true);
    const planning = adapter.planning;
    expect(
      planning?.read(planning.projection(parsed.rendered), url, parsed.identity).facts,
    ).toEqual(parsed.facts);
    expect(() =>
      planning?.read(planning.projection(parsed.rendered), url, {
        ...parsed.identity,
        variantId: "12",
      }),
    ).toThrow();
  });
  it("continues to read retained single-brand projections without a brand envelope", () => {
    const parsed = adapter.parseProduct(page());
    expect(adapter.planning?.read(parsed.evidence, url, parsed.identity)).toEqual({
      evidence: parsed.evidence,
      facts: parsed.facts,
    });
  });
  it("gives a multi-variant page's gallery and facts to the selected variant and hands the others back", () => {
    // Step 2 (owner 2026-10-21): one variant per URL. The page selects variant 11; variant 12 is discovered.
    const parsed = adapter.parseProduct(
      page({
        data: {
          ...data,
          variants: [
            { ...data.variants[0], featured_image: { src: "/eleven.jpg" } },
            { id: 12, price: 1400, featured_image: { src: "/twelve.jpg" } },
          ],
        },
      }),
    );
    expect(adapter.discoversVariants).toBe(true);
    expect(parsed.identity.variantId).toBe("11");
    expect(parsed.evidence.factsCandidates[0]?.scope).toBe("selected-product");
    expect(parsed.evidence.imageCandidates.every((image) => image.variantId === "11")).toBe(true);
    expect(parsed.evidence.imageCandidates.some((image) => image.url.endsWith("/eleven.jpg"))).toBe(
      true,
    );
    expect(parsed.evidence.imageCandidates.some((image) => image.url.endsWith("/twelve.jpg"))).toBe(
      false,
    );
    expect(parsed.evidence.warnings).toContain("DTC.GALLERY_SHARED_WITH_VARIANT");
    expect(parsed.variants.map((variant) => variant.variantId)).toEqual(["12"]);
    expect(parsed.evidence.variants.map((variant) => variant.variantId)).toEqual(["11", "12"]);
  });
  it("keeps a base page without a selection unassigned and discovers every variant", () => {
    const input = page({ data: { ...data, variants: [...data.variants, { id: 12 }] } });
    input.html = input.html.replace(/<input[^>]*>/, "");
    const base = adapter.parseProduct({ ...input, url: "https://shop.example/products/sleep" });
    expect(base.identity.variantId).toBeNull();
    expect(base.evidence.factsCandidates[0]?.scope).toBe("selected-product");
    expect(base.evidence.imageCandidates.every((image) => image.variantId === null)).toBe(true);
    expect(base.variants.map((variant) => variant.variantId)).toEqual(["11", "12"]);
  });
  it("reports a canonical identity conflict before requiring product content", () => {
    const wrong = {
      ...page(),
      html: '<link rel="canonical" href="https://shop.example/products/other">',
    };
    const identity = adapter.pageIdentity?.(wrong);
    expect(identity?.listingId).toBe(dtcIdentityKey("shop.example", "/products/other"));
    expect(
      identity && identitySighting(adapter.productAddress(url), identity, "retained.html")?.reason,
    ).toBe("identity_conflict");
  });
  it("takes selected identity from the form instead of the requested variant", () => {
    const observed = adapter.pageIdentity?.(
      page({
        selection: "12",
        data: { ...data, variants: [...data.variants, { id: 12, price: 1100 }] },
      }),
    );
    expect(observed?.variantId).toBe("12");
    expect(
      observed && identitySighting(adapter.productAddress(url), observed, "retained.html")?.reason,
    ).toBe("identity_conflict");
  });
  it.each([
    "https://evil.example/products/sleep",
    "http://shop.example/products/sleep",
    "https://u:p@shop.example/products/sleep",
    "https://shop.example/collections/all",
  ])("refuses foreign/nonproduct addresses: %s", (target) => {
    expect(() => adapter.productAddress(target)).toThrow();
  });
  it("normalizes collection-scoped product links and tracking queries", () => {
    expect(
      adapter.productAddress(
        "https://shop.example/collections/all/products/sleep?utm_source=x&variant=11",
      ),
    ).toEqual(adapter.productAddress(url));
  });
  it("without a rendered selection, a confirmed requested variant counts and a base address is the base product", () => {
    // Owner 2026-10-20 (DTC step 1): the platform path reads base pages of multi-variant products as the base
    // product (variant null), as the agent path records them; since step 2 the other variants are discovered.
    const input = page({ data: { ...data, variants: [...data.variants, { id: 12 }] } });
    input.html = input.html.replace(/<input[^>]*>/, "");
    expect(adapter.parseProduct(input).identity.variantId).toBe("11");
    const base = { ...input, url: "https://shop.example/products/sleep" };
    expect(adapter.parseProduct(base).identity.variantId).toBeNull();
    const unknown = { ...input, url: "https://shop.example/products/sleep?variant=99" };
    expect(() => adapter.parseProduct(unknown)).toThrow();
  });
  it("reports a variant address whose page renders another variant as an identity conflict", () => {
    // Step 2: the task is variant 12, but the form still selects 11 (a theme that ignores `?variant=`); the shared
    // capture turns the page identity into an unlisted sighting instead of collecting the wrong variant.
    const input = {
      ...page({
        selection: "11",
        data: { ...data, variants: [...data.variants, { id: 12, price: 1100 }] },
      }),
      url: "https://shop.example/products/sleep?variant=12",
    };
    const observed = adapter.pageIdentity?.(input);
    expect(observed?.variantId).toBe("11");
    expect(
      observed &&
        identitySighting(adapter.productAddress(input.url), observed, "retained.html")?.reason,
    ).toBe("identity_conflict");
  });
  it("refuses challenge pages and malformed product JSON", () => {
    expect(() => dtcDocument("<title>Just a moment...</title>")).toThrow();
    expect(() =>
      adapter.parseProduct({
        ...page(),
        html: page().html.replace('"title":"Sleep"', '"title":broken'),
      }),
    ).toThrow();
  });
  it("reads only the collection's product links and observed next address", () => {
    const document = dtcDocument(
      '<div id="product-grid"><a href="/products/sleep">Sleep</a></div><a href="/products/related">Related</a><a rel="next" href="?page=2">Next</a>',
    );
    const listing = readPlatformCatalog(document, { ...site.catalog, url: site.catalogUrl ?? "" });
    expect(listing.products).toHaveLength(1);
    expect(listing.nextUrl).toBe("https://shop.example/collections/all?page=2");
  });

  it.each([
    '<div class="product-sec"><div class="prod-row">',
    '<div><div class="product-list product-list--collection">',
  ])("reads scoped custom catalogs %s and deduplicates image/button links", (opening) => {
    const document = dtcDocument(`<header><a href="/products/navigation">Menu</a></header>
      <main>${opening}
      <div><a href="/products/sleep"><img src="/sleep.jpg"></a>
      <a href="/products/sleep">Buy Now</a></div>
      <div><a href="/products/magnesium">Magnesium</a></div></div></div>
      <aside class="product-list"><a href="/products/related">Recommended</a></aside></main>
      <footer><a href="/products/footer">Footer</a></footer>
      <a rel="next" href="?page=2">Next</a>`);
    const listing = readPlatformCatalog(document, { ...site.catalog, url: site.catalogUrl ?? "" });
    expect(listing.products.map((product) => product.url)).toEqual([
      "https://shop.example/products/sleep",
      "https://shop.example/products/magnesium",
    ]);
    expect(listing.nextUrl).toBe("https://shop.example/collections/all?page=2");
  });

  it("does not treat an unscoped row or product section as a verified catalog", () => {
    const document = dtcDocument(`<main><div class="prod-row">
      <a href="/products/sleep">Sleep</a></div>
      <div class="product-sec"><a href="/products/magnesium">Magnesium</a></div></main>`);
    expect(() =>
      readPlatformCatalog(document, { ...site.catalog, url: site.catalogUrl ?? "" }),
    ).toThrowError(expect.objectContaining({ code: "DTC.LISTING_UNVERIFIED" }));
  });
});
