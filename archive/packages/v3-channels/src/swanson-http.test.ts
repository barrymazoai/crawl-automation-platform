import { expect, it, vi } from "vitest";
import { RetainedPublication, sha256, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { ScraperApiTransport, type HttpRoute, type Response } from "@crawl-automation/v3-acquisition";
import { parseSwansonStaticHtml, SwansonHttpReader } from "./swanson-http.js";
import { SwansonHtmlArchive } from "./swanson-html-archive.js";
import { parseSwansonRenderedProduct } from "./swanson-rendered.js";

class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
  read = vi.fn(async (key: string, max: number) => { const b = this.data.get(key); if (b && b.length > max) throw Error("limit"); return b ?? null; });
  create = vi.fn(async (key: string, b: Uint8Array) => { if (this.data.has(key)) return "exists" as const; this.data.set(key, Buffer.from(b)); return "created" as const; });
}
const url = "https://www.swansonvitamins.com/p/healthy-origins-vitamin-k2-mk-7-100-mcg-180-veg-sgels";
// Shape of the server-rendered Swanson product page (checked through ScraperAPI 2026-09-28), trimmed.
const page = (extra = "") => `<!doctype html><html><head><title>Healthy Origins Vitamin K2 – Swanson Vitamins</title>
<link rel="canonical" href="${url}"><meta property="og:type" content="product"><meta property="og:url" content="${url}">
<script>var meta={"products":[]};(function(){var s=document.createElement('script');s.src='/cdn-cgi/challenge-platform/scripts/precursor/main.js';})();</script></head>
<body><main><h1>Natural Vitamin K2 as MK-7</h1>
<slideshow-slide><div class="product-media"><img src="//www.swansonvitamins.com/cdn/shop/files/front.jpg?v=1767382439&amp;width=1600" alt="Front"></div></slideshow-slide>
<product-form-component data-product-id="8572273787018"><input type="hidden" name="id" value="46318811709578"></product-form-component>
<input type="radio" role="radio" name="Size" value="60 Veggie Softgels" data-connected-product-url="/p/healthy-origins-vitamin-k2-mk-7-100-mcg-60-veg-sgels" data-variant-id="46318812266634" data-option-available="true">
<input type="radio" role="radio" name="Size" value="180 Veggie Softgels" checked data-connected-product-url="/p/healthy-origins-vitamin-k2-mk-7-100-mcg-180-veg-sgels" data-variant-id="46318811709578" data-option-available="true">
<details><summary>Product Details</summary><div>Vitamin K2 supports bone health.</div></details>
<details><summary>Product Facts</summary><div>Supplement Facts
Serving Size 1 Softgel
Servings Per Container 180
Vitamin K2 (from Natto)(as Menaquinone-7) 100 mcg
Other Ingredients: Vegetarian Softgel, Organic Extra Virgin Olive Oil, Yellow Beeswax, Sunflower Lecithin.</div></details>${extra}</main></body></html>`;

it("static page -> the same projection as the browser reader, accepted by the Swanson parser", () => {
  const p = parseSwansonStaticHtml(page(), url, "2026-09-28T10:00:00.000Z");
  expect(p).toMatchObject({ url, canonicalUrl: url, title: "Natural Vitamin K2 as MK-7", selectedForms: [{ productId: "8572273787018", variantIds: ["46318811709578"] }] });
  expect(p.gallery).toEqual([{ url: "https://www.swansonvitamins.com/cdn/shop/files/front.jpg?v=1767382439&width=1600", alt: "Front" }]);
  expect(p.variantPicker!.options.map(o => [o.label, o.selected, o.url])).toEqual([
    ["60 Veggie Softgels", false, "https://www.swansonvitamins.com/p/healthy-origins-vitamin-k2-mk-7-100-mcg-60-veg-sgels"],
    ["180 Veggie Softgels", true, url]]);
  expect(p.sections.map(s => s.heading)).toEqual(["Product Details", "Product Facts"]);
  const r = parseSwansonRenderedProduct(p, url, { listingId: "8572273787018", variantId: "46318811709578" });
  expect(r.factsCandidates[0]!.html).toContain("Other Ingredients");
});
it("a Cloudflare challenge page and a page without a single product heading are rejected", () => {
  expect(() => parseSwansonStaticHtml("<html><head><title>Just a moment...</title></head></html>", url, "2026-09-28T10:00:00.000Z")).toThrow(/ACCESS_CHALLENGE/);
  expect(() => parseSwansonStaticHtml(page("<h1>Second</h1>"), url, "2026-09-28T10:00:00.000Z")).toThrow(/PRODUCT_TEMPLATE/);
  expect(() => parseSwansonStaticHtml(page(), "https://evil.example/p/x", "2026-09-28T10:00:00.000Z")).toThrow();
});
it("the reader downloads once, archives before parsing, and afterwards only reads the archive", async () => {
  const remote = new Memory(), publication = new RetainedPublication(new Memory(), remote);
  const capture = { operationId: "swanson-capture-1", sessionId: "scraperapi-1", url, sourceId: "source", listingId: "healthy-origins-vitamin-k2", variantId: null };
  let calls = 0;
  const body = Buffer.from(page());
  const selection = { routeId: "route-test", version: "scraperapi/1", egressId: "scraperapi-us/1", mode: "scraperapi" as const, managed: true as const,
    countryCode: "us", sessionNumber: null, responseMode: "html" as const, providerPolicy: "scraperapi-sync/1" as const };
  const transport = new ScraperApiTransport(selection, { apiKey: "fake-key-000000", allowedOrigins: ["https://www.swansonvitamins.com"] }, async (): Promise<Response> => {
    calls++; return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-length": String(body.length) }, body: (async function* () { yield body; })(), close: () => {} };
  });
  const route: HttpRoute = { selection, transport, capabilities: transport.capabilities };
  const reader = new SwansonHttpReader(route);
  const first = await reader.product(url, AbortSignal.timeout(5000), new SwansonHtmlArchive(publication, capture));
  expect(calls).toBe(1); expect(first.title).toBe("Natural Vitamin K2 as MK-7");
  const receipt = JSON.parse(Buffer.from(remote.data.get("v3/swanson-html/swanson-capture-1/original.json")!).toString());
  expect(receipt).toMatchObject({ codec: "swanson-original-html/1", source: { sha256: sha256(body), producer: { module: "swanson.http-original" } } });
  const again = await reader.product(url, AbortSignal.timeout(5000), new SwansonHtmlArchive(publication, capture));
  expect(calls).toBe(1); expect(again).toEqual(first);
  // A lost answer after the request intent never becomes a second paid download.
  const lost = new SwansonHtmlArchive(publication, { ...capture, operationId: "swanson-capture-2" });
  await lost.beginDownload(AbortSignal.timeout(5000));
  await expect(reader.product(url, AbortSignal.timeout(5000), lost)).rejects.toThrow(/HTML_DOWNLOAD_UNRESOLVED/);
  expect(calls).toBe(1);
});
