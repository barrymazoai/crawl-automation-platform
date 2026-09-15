import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AmazonRenderedProductSchema } from "@crawl-automation/v3-contracts";
import { CommerceEvidenceSchema } from "../../v3-contracts/src/commerce.js";
import { ScraperApiTransport, type HttpRoute, type Response } from "@crawl-automation/v3-acquisition";
import { AmazonHttpReader, amazonStaticGallery, amazonStaticTwister, parseAmazonStaticHtml, readAmazonHtml, AMAZON_HTTP_POLICY } from "./amazon-http.js";
import { parseAmazonRenderedProduct } from "./amazon-rendered.js";

const here = dirname(fileURLToPath(import.meta.url));
const page = (asin: string) => gunzipSync(readFileSync(join(here, "fixtures", `amazon-static-${asin}.html.gz`))).toString("utf8");
const url = (asin: string) => `https://www.amazon.com/dp/${asin}`;
const route = { routeId: "route-test", version: "scraperapi/1", egressId: "scraperapi-us/1", mode: "scraperapi" as const, managed: true as const,
  countryCode: "us", sessionNumber: null, responseMode: "html" as const, providerPolicy: "scraperapi-sync/1" as const };
const privateConfig = { apiKey: "fake-key-000000", allowedOrigins: ["https://www.amazon.com"] };
function fakeRoute(reply: (target: URL) => { status: number; type?: string; body: string }): HttpRoute & { calls: URL[] } {
  const calls: URL[] = [];
  const transport = new ScraperApiTransport(route, privateConfig, async (providerUrl): Promise<Response> => {
    const target = new URL(providerUrl.searchParams.get("url")!); calls.push(target);
    const r = reply(target), bytes = Buffer.from(r.body);
    return { status: r.status, headers: { "content-type": r.type ?? "text/html;charset=UTF-8", "content-length": String(bytes.length) },
      body: (async function* () { yield bytes; })(), close: () => {} };
  });
  return { selection: route, transport, capabilities: transport.capabilities, calls };
}

describe("static Amazon HTML parses into the browser projection", () => {
  it("B0G963NB8Q: title, store, USD selected-offer price, seller link, gallery from colorImages, no variants", () => {
    const p = parseAmazonStaticHtml(page("B0G963NB8Q"), url("B0G963NB8Q"));
    expect(AmazonRenderedProductSchema.parse(p)).toEqual(p);
    expect(p.asin).toBe("B0G963NB8Q");
    expect(p.title.startsWith("Horbäach Collagen Peptides")).toBe(true);
    expect(p.canonicalUrl).toBe("https://www.amazon.com/Horb%C3%A4ach-Collagen-Peptides-Hyaluronic-Supplement/dp/B0G963NB8Q");
    expect(p.storeUrl).toContain("/stores/HORBAACH/page/AFF1641C-FFC5-4F4A-BF78-72E4B9E89902");
    expect(p.deliveryText).toBe("Delivering to Ashburn 20146 Update location");
    expect(p.sections.map(s => s.id)).toEqual(["feature-bullets", "important-information"]);
    expect(p.sections.find(s => s.id === "important-information")!.text).toMatch(/Ingredients/i);
    expect(p.galleryCount).toBe(7); expect(p.gallery).toHaveLength(7);
    expect(p.gallery.every((g, i) => g.index === i && g.url.startsWith("https://m.media-amazon.com/images/I/") && g.url.includes("_SL1500_"))).toBe(true);
    expect(new Set(p.gallery.map(g => g.url)).size).toBe(7);
    expect(p.variantControls).toBe(0); expect(p.variants).toEqual([]); expect(p.parentAsin).toBe("B0G963NB8Q");
    const c = CommerceEvidenceSchema.parse(p.commerce);
    expect(c.price).toBe("$9.99"); expect(c.currency).toBe("USD"); expect(c.availability).toBe("In Stock");
    expect(c.rating).toBe("4.4 out of 5 stars"); expect(c.reviewCount).toBe("(19)");
    expect(c.purchaseConditions).toMatchObject({ purchaseType: "one_time", priceScope: "selected_offer", quantity: 1,
      seller: { name: "Carlyle", id: "A1LS1XJ2SPG90C" }, delivery: { postalCode: "20146" } });
    expect(c.purchaseConditions!.warnings).not.toContain("PURCHASE.PRICE_BINDING_UNKNOWN");
    // Downstream evidence derivation is unchanged: the same validator the browser path uses accepts it.
    const evidence = parseAmazonRenderedProduct(p, url("B0G963NB8Q"), { listingId: "B0G963NB8Q", variantId: null });
    expect(evidence.imageCandidates).toHaveLength(7); expect(evidence.warnings).toContain("AMAZON.SELECTED_ASIN_ONLY");
  });
  it("B0013LAQS6: Amazon-sold offer gets the merchant widget seller; twister siblings become variants with the parent ASIN", () => {
    const html = page("B0013LAQS6"), p = parseAmazonStaticHtml(html, url("B0013LAQS6"));
    expect(p.parentAsin).toBe("B0CWSXGT5V");
    const twister = amazonStaticTwister(html);
    expect(twister.siblings.some(s => s.asin === "B0013LAQS6")).toBe(true);
    expect(p.variants.map(v => v.asin)).toEqual(twister.siblings.map(s => s.asin).filter(a => a !== "B0013LAQS6"));
    expect(p.variants.every(v => v.url === url(v.asin) && v.label.length > 0)).toBe(true);
    expect(p.variantControls).toBeGreaterThanOrEqual(1);
    expect(p.galleryCount).toBe(6);
    expect(p.commerce!.price).toBe("$10.45");
    expect(p.commerce!.purchaseConditions).toMatchObject({ purchaseType: "one_time", seller: { name: "Amazon.com", id: null, url: null } });
    expect(p.commerce!.purchaseConditions!.warnings).not.toContain("PURCHASE.SELLER_UNKNOWN");
    const evidence = parseAmazonRenderedProduct(p, url("B0013LAQS6"), { listingId: "B0013LAQS6", variantId: null });
    expect(evidence.variants.map(v => v.listingId)).toEqual(p.variants.map(v => v.asin));
    expect(evidence.warnings).toContain("AMAZON.VARIANT_ENUMERATION_UNVERIFIED");
  });
  it("gallery prefers hiRes, falls back to large, dedupes, and rejects foreign hosts", () => {
    const script = (items: string) => `<script>P.when('A').register("ImageBlockATF", function(A){ var data = { 'colorImages': { 'initial': A.$.parseJSON('${items}') } }; });</script>`;
    expect(amazonStaticGallery(script('[{"hiRes":"https://m.media-amazon.com/images/I/a._AC_SL1500_.jpg","large":"https://m.media-amazon.com/images/I/a._AC_.jpg","variant":"MAIN"},{"hiRes":null,"large":"https://m.media-amazon.com/images/I/b._AC_.jpg","variant":"PT01"},{"hiRes":"https://m.media-amazon.com/images/I/a._AC_SL1500_.jpg"},{"hiRes":"https://evil.example/x.jpg"}]')))
      .toEqual([{ url: "https://m.media-amazon.com/images/I/a._AC_SL1500_.jpg", alt: "MAIN" }, { url: "https://m.media-amazon.com/images/I/b._AC_.jpg", alt: "PT01" }]);
    expect(amazonStaticGallery("<html></html>")).toEqual([]);
    expect(() => parseAmazonStaticHtml(page("B0G963NB8Q").replace(/'colorImages'/g, "'noImages'"), url("B0G963NB8Q"))).toThrow("AMAZON.GALLERY_UNVERIFIED");
  });
  it("challenge pages and foreign ASINs never become projections", () => {
    expect(() => parseAmazonStaticHtml("<html><body><form action=\"/errors/validateCaptcha\">Enter the characters you see below</form></body></html>", url("B0G963NB8Q"))).toThrow("AMAZON.ACCESS_CHALLENGE");
    expect(() => parseAmazonStaticHtml(page("B0G963NB8Q"), url("B0013LAQS6"))).toThrow("AMAZON.ASIN_CONFLICT");
  });
});

describe("AmazonHttpReader over the ScraperAPI route", () => {
  it("fetches once through the provider, records the route, and validates like the browser reader", async () => {
    const r = fakeRoute(() => ({ status: 200, body: page("B0G963NB8Q") })), reader = new AmazonHttpReader(r);
    const retained: unknown[] = [];
    const p = await reader.product(url("B0G963NB8Q"), AbortSignal.timeout(5000), async raw => { retained.push(raw); });
    expect(r.calls.map(u => u.href)).toEqual([url("B0G963NB8Q")]);
    expect(p.fetchedVia).toEqual({ mode: "http", routeId: "route-test", egressId: "scraperapi-us/1", provider: "scraperapi-sync/1" });
    expect(retained).toEqual([p]);
    expect(p.commerce!.price).toBe("$9.99");
  });
  it("rejects delivery postal-code requirements, ASIN mismatches, challenges, not-found and redirects", async () => {
    await expect(new AmazonHttpReader(fakeRoute(() => ({ status: 200, body: page("B0G963NB8Q") }))).product(url("B0G963NB8Q"), AbortSignal.timeout(5000), undefined, "10001")).rejects.toThrow("AMAZON.DELIVERY_POLICY_UNSUPPORTED");
    await expect(new AmazonHttpReader(fakeRoute(() => ({ status: 200, body: page("B0G963NB8Q") }))).product(url("B0013LAQS6"), AbortSignal.timeout(5000))).rejects.toThrow("AMAZON.ASIN_CONFLICT");
    await expect(readAmazonHtml(fakeRoute(() => ({ status: 200, body: "<html>Robot Check</html>" })), url("B0G963NB8Q"), AbortSignal.timeout(5000)).then(html => parseAmazonStaticHtml(html, url("B0G963NB8Q")))).rejects.toThrow("AMAZON.ACCESS_CHALLENGE");
    await expect(readAmazonHtml(fakeRoute(() => ({ status: 404, body: "gone" })), url("B0G963NB8Q"), AbortSignal.timeout(5000))).rejects.toThrow("AMAZON.NOT_FOUND");
    // Provider-level failures surface as the transport's own typed errors, never as a projection.
    await expect(readAmazonHtml(fakeRoute(() => ({ status: 503, body: "busy" })), url("B0G963NB8Q"), AbortSignal.timeout(5000))).rejects.toThrow("SCRAPERAPI.PROVIDER_FAILURE");
    await expect(readAmazonHtml(fakeRoute(() => ({ status: 429, body: "slow down" })), url("B0G963NB8Q"), AbortSignal.timeout(5000))).rejects.toThrow("SCRAPERAPI.THROTTLED");
    await expect(readAmazonHtml(fakeRoute(() => ({ status: 200, type: "application/json", body: "{}" })), url("B0G963NB8Q"), AbortSignal.timeout(5000))).rejects.toThrow("AMAZON.NOT_HTML");
    await expect(readAmazonHtml(fakeRoute(() => ({ status: 200, body: "x".repeat(AMAZON_HTTP_POLICY.maxBytes + 1) })), url("B0G963NB8Q"), AbortSignal.timeout(5000))).rejects.toThrow("AMAZON.PAGE_LIMIT");
    await expect(readAmazonHtml(fakeRoute(() => ({ status: 200, body: "<html></html>" })), "https://evil.example/dp/B0G963NB8Q", AbortSignal.timeout(5000))).rejects.toThrow("SOURCE.ORIGIN_BLOCKED");
  });
});
