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
  });
  it("keeps the requested first site unverified", () => {
    expect(() =>
      dtcAdapter.parseProduct({ ...page(), url: "https://nutriessential.com/products/sleep" }),
    ).toThrowError(/browser check/);
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
      availability: "in_stock",
    });
    expect(parsed.variants[0]?.variantId).toBe("11");
  });
  it("takes gallery and accordion images without recommendations", () => {
    const urls = adapter.parseProduct(page()).evidence.imageCandidates.map((image) => image.url);
    expect(urls).toEqual(["https://shop.example/front.jpg", "https://shop.example/label.jpg"]);
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
  it("does not assign common facts to every flavour", () => {
    const parsed = adapter.parseProduct(
      page({ data: { ...data, variants: [...data.variants, { id: 12, price: 1400 }] } }),
    );
    expect(parsed.facts.complete).toBe(false);
    expect(parsed.evidence.factsCandidates[0]?.scope).toBe("product-unassigned-variant");
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
  it("refuses missing rendered selection on a multi-variant product", () => {
    const input = page({ data: { ...data, variants: [...data.variants, { id: 12 }] } });
    input.html = input.html.replace(/<input[^>]*>/, "");
    expect(() => adapter.parseProduct(input)).toThrow();
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
});
