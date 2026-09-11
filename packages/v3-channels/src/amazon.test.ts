import { describe, expect, it } from "vitest";
import { parseAmazonProduct, parseAmazonStore } from "./amazon.js";
// Synthetic structural fixtures only. Store #stores selector still requires a live replay.
const asin = "B000000001", other = "B000000002", third = "B000000003";
const origin = "https://www.amazon.com", productUrl = `${origin}/dp/${asin}`, storeUrl = `${origin}/stores/Example/page/fixture`;
const image = "https://m.media-amazon.com/images/I/label._AC_SL300_.jpg";
const detail = (extra = "") => `<input id="ASIN" value="${asin}"><div id="ppd"><h1 id="productTitle">B12 &amp; Folate</h1>
  <a id="bylineInfo">Example Brand</a><div id="imageBlock"><img src="${image}"></div>
  <div id="important-information">Other ingredients: rice flour</div><div id="twister"><a href="/dp/${other}">120 capsules</a></div>${extra}</div>
  <div id="recommendations"><img src="https://m.media-amazon.com/unrelated.jpg"><a href="/dp/${third}">Unrelated</a></div>`;
const tile = (id = asin, attrs = "") => `<div data-asin="${id}" ${attrs}><a href="/dp/${id}?ref=store">Product ${id}</a></div>`;
const store = (extra = "") => `<div id="stores">${tile()}${extra}</div><div id="recommendations">${tile(third)}</div>`;
describe("Amazon saved-evidence candidate parser", () => {
  it("ignores the live warranty input duplicate outside #ppd but still rejects two product headings inside", () => {
    const html = detail() + '<div id="warranty"><input id="productTitle" value="a hidden warranty value"></div>';
    expect(parseAmazonProduct(html, productUrl, asin).title).toBe("B12 & Folate");
    expect(() => parseAmazonProduct(detail('<h1 id="productTitle">Another product</h1>'), productUrl, asin)).toThrow("CHANNEL.IDENTITY_CONFLICT");
  });
  it("does not use an outside title when the main product heading is missing", () => {
    const html = detail().replace('id="productTitle"', 'id="missing"') + '<h1 id="productTitle">Outside product</h1>';
    expect(() => parseAmazonProduct(html, productUrl, asin)).toThrow("AMAZON.PRODUCT_UNVERIFIED");
  });
  it("recognizes observed localized store URLs without claiming an unknown live template is verified", () => {
    const url = `${origin}/-/zh/stores/UNIQUEE/page/7B3902F7-D6C8-4226-97B1-BEB72807BEB3`;
    expect(parseAmazonStore(store(), url).entries).toHaveLength(1);
    expect(() => parseAmazonStore('<div class="ProductGrid__grid">Actual grid needs its own profile</div>', url)).toThrow("AMAZON.STORE_TEMPLATE_UNVERIFIED");
  });
  it("extracts selected ASIN title and gallery, excluding outside recommendations", () => {
    const out = parseAmazonProduct(detail(), productUrl, asin);
    expect(out.listingId).toBe(asin); expect(out.title).toBe("B12 & Folate"); expect(out.brandRaw).toBe("Example Brand");
    expect(out.imageCandidates).toEqual([{ url: image, variantId: null, basis: "selected-gallery", verifiedOriginal: false }]);
    expect(out.variants.map(v => v.listingId)).toEqual([other]); expect(out.factsCandidates[0]?.scope).toBe("selected-product");
    expect(out.warnings).toContain("CHANNEL.PROFILE_LIVE_UNVERIFIED");
  });
  it("keeps explicit image URLs verbatim without inventing high-resolution URLs", () => {
    const html = detail().replace(`<img src="${image}">`, `<img src="${image}" data-old-hires="https://m.media-amazon.com/full.jpg" data-a-dynamic-image='{"https://m.media-amazon.com/explicit.jpg":[1200,1200]}'>`);
    const out = parseAmazonProduct(html, productUrl, asin);
    expect(out.imageCandidates.map(i => i.url)).toEqual(["https://m.media-amazon.com/full.jpg", "https://m.media-amazon.com/explicit.jpg"]);
  });
  it.each([
    detail().replace(`value="${asin}"`, `value="${other}"`), detail().replace('id="ppd"', 'id="other"'),
    detail().replace('id="productTitle"', 'id="unverifiedTitle"'),
  ])("rejects unverified product roots/identity", html => { expect(() => parseAmazonProduct(html, productUrl, asin)).toThrow("AMAZON.PRODUCT_UNVERIFIED"); });
  it("rejects mismatched task URL/ASIN and duplicate identity elements", () => {
    expect(() => parseAmazonProduct(detail(), `${origin}/dp/${other}`, asin)).toThrow("AMAZON.ASIN_CONFLICT");
    expect(() => parseAmazonProduct(detail('<input id="ASIN" value="B000000001">'), productUrl, asin)).toThrow("CHANNEL.IDENTITY_CONFLICT");
  });
  it.each(["Robot Check", "Pardon Our Interruption", "Verify you are human"])("classifies %s as challenge, not an empty product", text => {
    expect(() => parseAmazonProduct(`<h1>${text}</h1>`, productUrl, asin)).toThrow("CHANNEL.ACCESS_CHALLENGE");
  });
  it("ignores challenge words in scripts but rejects a captcha form", () => {
    expect(parseAmazonProduct(detail('<script>const x="Robot Check"</script>'), productUrl, asin).listingId).toBe(asin);
    expect(() => parseAmazonProduct(detail('<form action="/errors/validateCaptcha"></form>'), productUrl, asin)).toThrow("CHANNEL.ACCESS_CHALLENGE");
  });
  it.each(["not-json", "[]", "null"])("rejects malformed dynamic gallery metadata", value => {
    expect(() => parseAmazonProduct(detail().replace(`<img src="${image}">`, `<img data-a-dynamic-image='${value}'>`), productUrl, asin)).toThrow("AMAZON.GALLERY_INVALID");
  });
  it("does not accept foreign image hosts or deep/oversized documents", () => {
    expect(() => parseAmazonProduct(detail().replace(image, "https://evil.example/image.jpg"), productUrl, asin)).toThrow("CHANNEL.IMAGE_URL_REJECTED");
    expect(() => parseAmazonProduct("<div>".repeat(130), productUrl, asin)).toThrow("CHANNEL.PAGE_LIMIT");
    expect(() => parseAmazonProduct("x".repeat(4 * 1024 * 1024 + 1), productUrl, asin)).toThrow("CHANNEL.PAGE_LIMIT");
  });
  it("keeps store discovery within catalog tiles, excluding recommendations and sponsored tiles", () => {
    const out = parseAmazonStore(store(tile() + tile(other, 'data-sponsored="true"')), storeUrl);
    expect(out.entries.map(e => e.listingId)).toEqual([asin]); expect(out.completion).toBe("unverified_end");
    expect(out.reportedTotal).toBeNull(); expect(out.warnings).toContain("AMAZON.STORE_COVERAGE_UNVERIFIED");
  });
  it("next-page hints remain incremental, never a full brand inventory assertion", () => {
    const out = parseAmazonStore(store('<a rel="next" href="?page=2">Next</a>'), storeUrl);
    expect(out.completion).toBe("more"); expect(out.nextUrl).toBe(`${storeUrl}?page=2`);
  });
  it("rejects a search page, unknown template and empty catalog as unverified", () => {
    expect(() => parseAmazonStore(store(), `${origin}/s?k=Example`)).toThrow("AMAZON.STORE_REQUIRED");
    expect(() => parseAmazonStore('<div id="unknown">Products</div>', storeUrl)).toThrow("AMAZON.STORE_TEMPLATE_UNVERIFIED");
    expect(() => parseAmazonStore('<div id="stores"></div>', storeUrl)).toThrow("AMAZON.CATALOG_UNVERIFIED");
  });
  it("rejects tile ASIN versus product-link mismatches", () => {
    expect(() => parseAmazonStore(store().replace(`href="/dp/${asin}`, `href="/dp/${other}`), storeUrl)).toThrow("AMAZON.ASIN_CONFLICT");
  });
  it.each([
    `<a rel="next" href="${storeUrl}">Next</a>`, '<a rel="next" href="/stores/Other/page/other">Next</a>',
    '<a rel="next" href="?page=2">Next</a><a rel="next" href="?page=3">Next</a>',
    '<a rel="next" href="https://evil.example/">Next</a>',
  ])("rejects ambiguous or cross-store pagination", next => { expect(() => parseAmazonStore(store(next), storeUrl)).toThrow(); });
});
