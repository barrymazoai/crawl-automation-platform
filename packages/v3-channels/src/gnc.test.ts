import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { GncAdapter, GNC_POLICY, parseGncCatalog, parseGncProduct, type GncPageReader, type GncReceivedPage } from "./gnc.js";

const url = "https://www.gnc.com/vitamins/123456.html";
const product = { "@type": "Product", sku: "123456", name: "Test vitamin", brand: { name: "Example" }, image: "https://images.gnc.com/123456.jpg", offers: { url } };
const ld = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
const facts = '<div id="productIngredientsAccordionContent"><table><tr><th rowspan="2">Vitamin C</th><td>10 mg</td></tr></table><p>Other ingredients: cellulose</p></div>';
const html = ld(product) + facts;
const tile = (href: string) => `<div class="product-tile"><a href="${href}">Product</a></div>`;
const input = { kind: "product" as const, requestId: "request-1", operationId: "operation-1", brandId: "brand-1", sourceId: "source-1", binding: { sessionId: "session-1", egressId: "direct-v1" }, url, sku: "123456" };
function harness(overrides: Partial<Awaited<ReturnType<GncPageReader["read"]>>> = {}) {
  const read = vi.fn<GncPageReader["read"]>().mockResolvedValue({ operationId: input.operationId, requestedUrl: url, finalUrl: url, binding: input.binding, status: 200, contentType: "text/html; charset=utf-8", bytes: Buffer.from(html), ...overrides });
  return { read, adapter: new GncAdapter({ read }) };
}

describe("GNC product evidence, synthetic DOM", () => {
  it("preserves exact facts DOM, spans and original image candidate without PDF work", () => {
    const result = parseGncProduct(html + '<a href="/123456_lbl.pdf">PDF</a>', url, "123456");
    expect(result.factsHtml).toBe(facts);
    expect(result.imageCandidates).toEqual([{ url: product.image, basis: "sku-jsonld", verifiedOriginal: false }]);
    expect(result.brandRaw).toBe("Example");
  });
  it("retains incomplete facts, leaving semantic eligibility downstream", () => {
    const partial = '<div id="productIngredientsAccordionContent">Other ingredients: cellulose</div>';
    expect(parseGncProduct(ld(product) + partial, url, "123456").factsHtml).toBe(partial);
  });
  it("does not invent missing facts or company mapping", () => {
    const r = parseGncProduct(ld({ ...product, brand: null }), url, "123456");
    expect(r.factsHtml).toBeNull(); expect(r.brandRaw).toBeNull();
    expect(r.warnings).toContain("GNC.FACTS_DOM_MISSING");
  });
  it("selects exact SKU and only its own ProductGroup variants, not recommendations", () => {
    const sibling = { ...product, sku: "234567", offers: { url: "/vitamins/234567.html" } };
    const recommendation = { ...product, sku: "999999", offers: { url: "/vitamins/999999.html" }, image: "https://images.gnc.com/unrelated.jpg" };
    const data = [recommendation, { "@type": "ProductGroup", hasVariant: [product, sibling] }];
    const r = parseGncProduct(ld(data) + facts, url, "123456");
    expect(r.variantUrls).toEqual(["https://www.gnc.com/vitamins/234567.html"]);
    expect(r.imageCandidates.map(i => i.url)).toEqual([product.image]);
  });
  it("never falls back to the first unrelated product", () => {
    expect(() => parseGncProduct(ld({ ...product, sku: "999999" }), url, "123456")).toThrow("GNC.SKU_UNVERIFIED");
  });
  it("rejects a sibling whose offer URL points to a different SKU", () => {
    const group = { "@type": "ProductGroup", hasVariant: [product, { ...product, sku: "234567" }] };
    expect(() => parseGncProduct(ld(group), url, "123456")).toThrow("GNC.SKU_CONFLICT");
  });
  it.each([
    [ld([product, { ...product, name: "Different" }]), "GNC.SKU_AMBIGUOUS"],
    [ld({ ...product, offers: { url: "/999999.html" } }), "GNC.SKU_CONFLICT"],
    [ld({ ...product, name: "" }), "GNC.TITLE_MISSING"],
    [html + facts, "GNC.DOM_AMBIGUOUS"],
    ['<script type="application/ld+json">{broken</script>', "GNC.JSON_INVALID"],
  ])("classifies invalid evidence: %s", (page, error) => {
    expect(() => parseGncProduct(page, url, "123456")).toThrow(error);
  });
  it("does not mistake embedded captcha library names for a denied page", () => {
    expect(parseGncProduct(html + '<script>PerimeterX("RateLimiter-HideCaptcha")</script>', url, "123456").sku).toBe("123456");
  });
  it.each(["<h1>Pardon Our Interruption</h1>", '<div id="px-captcha"></div>'])("detects actual challenge: %s", challenge => {
    expect(() => parseGncProduct(html + challenge, url, "123456")).toThrow("GNC.ACCESS_CHALLENGE");
  });
  it("keeps only scoped gallery images and does not claim original resolution", () => {
    const r = parseGncProduct(html + '<img src="/banner.jpg"><div id="product-images"><img src="/label.jpg?width=100"><img src="/label.pdf"></div>', url, "123456");
    expect(r.imageCandidates.map(i => i.url)).toEqual([product.image, "https://www.gnc.com/label.jpg?width=100"]);
    expect(r.imageCandidates.every(i => !i.verifiedOriginal)).toBe(true);
  });
  it("captures the current thumbnail grid using explicit zoom URLs, retaining unit-pack assets without inventing URLs", () => {
    const gallery = '<div class="product-thumbnails-grid d-none d-lg-flex">' +
      '<img alt="Test vitamin" src="/123456-front.jpg?sw=480" data-zoom-url="/123456-front.jpg?sw=1500&amp;sh=1500">' +
      '<img alt="Test vitamin" src="/123457-unit-back.jpg?sw=480" data-zoom-url="/123457-unit-back.jpg?sw=1500">' +
      '<img alt="Test vitamin" src="/123457-unit-back.jpg?sw=480" data-zoom-url="/123457-unit-back.jpg?sw=1500"></div>';
    const r = parseGncProduct(html + gallery, url, "123456");
    expect(r.imageCandidates.map(i => i.url)).toEqual([product.image,
      "https://www.gnc.com/123456-front.jpg?sw=1500&sh=1500", "https://www.gnc.com/123457-unit-back.jpg?sw=1500"]);
    expect(r.imageCandidates.every(i => !i.verifiedOriginal)).toBe(true);
  });
  it.each(["recommendation", "recommendations", "product-tile"])("ignores galleries nested in %s components", wrapper => {
    const gallery = '<div class="product-thumbnails-grid"><img alt="Test vitamin" src="/unrelated.jpg"></div>';
    expect(parseGncProduct(html + `<div class="${wrapper}">${gallery}</div>`, url, "123456").imageCandidates.map(i => i.url)).toEqual([product.image]);
  });
  it("requires the current gallery's product title and rejects foreign data-pid/hidden template ownership", () => {
    const gallery = '<div class="product-thumbnails-grid"><img alt="Test vitamin" src="/unrelated.jpg"></div>';
    for (const extra of [gallery.replace('alt="Test vitamin"', 'alt="Other vitamin"'), `<div data-pid="999999">${gallery}</div>`, `<template>${gallery}</template>`]) {
      expect(parseGncProduct(html + extra, url, "123456").imageCandidates.map(i => i.url)).toEqual([product.image]);
    }
  });
  it("rejects over-size and deep pages instead of truncating", () => {
    expect(() => parseGncProduct(" ".repeat(GNC_POLICY.maxBytes + 1), url, "123456")).toThrow("GNC.PAGE_LIMIT");
    expect(() => parseGncProduct("<div>".repeat(130) + html, url, "123456")).toThrow("GNC.PAGE_LIMIT");
  });
});

describe("GNC single catalog page", () => {
  const catalog = "https://www.gnc.com/brands/example/";
  it("discovers SKU and family cards incrementally, deduplicates, preserves next URL", () => {
    const r = parseGncCatalog(tile(url) + tile(url) + tile("/vitamins/family.html") + '<a href="/999999.html">Unrelated</a><button class="load-more-btn" data-grid-url="/next?start=24&amp;sz=24"></button>', catalog);
    expect(r.entries.map(e => e.kind)).toEqual(["sku", "family"]);
    expect(r.nextUrl).toBe("https://www.gnc.com/next?start=24&sz=24"); expect(r.completion).toBe("more");
  });
  it("does not call absent next control proof of completed brand", () => {
    expect(parseGncCatalog(tile(url), catalog).completion).toBe("unverified_end");
  });
  it.each([
    ["<p>Empty</p>", "GNC.CATALOG_UNVERIFIED"],
    [tile("https://evil.test/123456.html"), "GNC.URL_REJECTED"],
    [tile(url) + `<a rel="next" href="${catalog}">Next</a>`, "GNC.PAGINATION_CONFLICT"],
    [tile(url) + '<a rel="next" href="/one">Next</a><a rel="next" href="/two">Next</a>', "GNC.PAGINATION_CONFLICT"],
  ])("rejects uncertain catalog: %s", (page, error) => {
    expect(() => parseGncCatalog(page, catalog)).toThrow(error);
  });
});

describe("injected single read, no hidden retries or handoff claim", () => {
  it.each([200, 307, 403, 406, 429, 503])("retains UTF-8 challenge HTML for HTTP %s before rejecting it", async status => {
    const body = '<title>Access to this page has been denied</title><p>Press &amp; Hold</p>';
    const { adapter, read } = harness({ status, bytes: Buffer.from(body) });
    const retain = vi.fn(async (_page: GncReceivedPage) => {});
    await expect(adapter.capture(input, new AbortController().signal, retain)).rejects.toThrow("GNC.ACCESS_CHALLENGE");
    expect(read).toHaveBeenCalledTimes(1); expect(retain).toHaveBeenCalledTimes(1);
    expect(retain.mock.calls[0]![0]).toMatchObject({ html: Buffer.from(body), sha256: createHash("sha256").update(body).digest("hex") });
  });
  it.each([[307, "GNC.HTTP_STATUS"], [404, "GNC.NOT_FOUND"], [500, "GNC.HTTP_STATUS"]])("retains ordinary HTTP %s HTML without promoting it to success or challenge", async (status, code) => {
    const { adapter } = harness({ status: Number(status), bytes: Buffer.from('<p>Not a product</p><script>"Press & Hold"</script>') });
    const retain = vi.fn(async (_page: GncReceivedPage) => {});
    await expect(adapter.capture(input, new AbortController().signal, retain)).rejects.toThrow(String(code));
    expect(retain).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ finalUrl: "https://www.gnc.com/other.html" }, "GNC.REDIRECT_UNVERIFIED"],
    [{ operationId: "foreign" }, "GNC.SESSION_CONFLICT"],
    [{ bytes: Buffer.alloc(GNC_POLICY.maxBytes + 1) }, "GNC.PAGE_LIMIT"],
    [{ bytes: Buffer.from([255]) }, "GNC.ENCODING"],
    [{ contentType: "application/json" }, "GNC.HTTP_STATUS"],
    [{ status: 0 }, "GNC.HTTP_STATUS"],
  ])("does not retain unsafe or unowned error pages: %j", async (patch, code) => {
    const { adapter } = harness({ status: 307, ...patch }); const retain = vi.fn();
    await expect(adapter.capture(input, new AbortController().signal, retain)).rejects.toThrow(code);
    expect(retain).not.toHaveBeenCalled();
  });
  it("does not mask failed evidence handoff with a challenge classification or retry", async () => {
    const { adapter, read } = harness({ status: 307, bytes: Buffer.from('<p>Press &amp; Hold</p>') });
    const retain = vi.fn().mockRejectedValue(new Error("GNC.PUBLICATION_UNKNOWN"));
    await expect(adapter.capture(input, new AbortController().signal, retain)).rejects.toThrow("GNC.PUBLICATION_UNKNOWN");
    expect(read).toHaveBeenCalledTimes(1); expect(retain).toHaveBeenCalledTimes(1);
  });
  it("returns unchanged raw bytes and hash without claiming durable completion", async () => {
    const { adapter, read } = harness(); const r = await adapter.capture(input, new AbortController().signal);
    expect(read).toHaveBeenCalledTimes(1); expect(Buffer.from(r.html).toString()).toBe(html);
    expect(r.sha256).toBe(createHash("sha256").update(html).digest("hex")); expect(r.artifactDurable).toBe(false);
  });
  it.each([
    [{ status: 403 }, "GNC.ACCESS_CHALLENGE"], [{ status: 429 }, "GNC.ACCESS_CHALLENGE"],
    [{ status: 404 }, "GNC.NOT_FOUND"], [{ status: 500 }, "GNC.HTTP_STATUS"],
    [{ contentType: "application/pdf" }, "GNC.NOT_HTML"],
    [{ contentType: "text/html; charset=latin1" }, "GNC.ENCODING"],
    [{ bytes: new Uint8Array([255]) }, "GNC.ENCODING"],
    [{ operationId: "wrong" }, "GNC.SESSION_CONFLICT"],
    [{ binding: { sessionId: "wrong", egressId: "direct-v1" } }, "GNC.SESSION_CONFLICT"],
    [{ finalUrl: "https://www.gnc.com/other/123456.html" }, "GNC.REDIRECT_UNVERIFIED"],
  ])("classifies without retry: %j", async (override, error) => {
    const { adapter, read } = harness(override);
    await expect(adapter.capture(input, new AbortController().signal)).rejects.toThrow(error);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("rejects foreign input before any network call", async () => {
    const { adapter, read } = harness();
    await expect(adapter.capture({ ...input, url: "https://evil.test/123456.html" }, new AbortController().signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("does not retry reader failure or switch network", async () => {
    const { adapter, read } = harness(); read.mockRejectedValue(new Error("NETWORK.TIMEOUT"));
    await expect(adapter.capture(input, new AbortController().signal)).rejects.toThrow("NETWORK.TIMEOUT");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("dispatches a catalog-page request without requiring a product SKU", async () => {
    const catalogInput = { kind: "catalog-page", requestId: input.requestId, operationId: input.operationId, brandId: input.brandId, sourceId: input.sourceId, binding: input.binding, url: "https://www.gnc.com/brands/example/" };
    const { adapter } = harness({ requestedUrl: catalogInput.url, finalUrl: catalogInput.url, bytes: Buffer.from(tile(url)) });
    const r = await adapter.capture(catalogInput, new AbortController().signal);
    expect(r.data).toMatchObject({ entries: [{ sku: "123456" }], completion: "unverified_end" });
  });
  it("propagates cancellation before and after read", async () => {
    const { adapter, read } = harness(); const c = new AbortController(); c.abort();
    await expect(adapter.capture(input, c.signal)).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
    const later = new AbortController(); const response = await harness().read(input, later.signal);
    read.mockImplementation(async () => { later.abort(); return response; });
    await expect(adapter.capture(input, later.signal)).rejects.toThrow(); expect(read).toHaveBeenCalledTimes(1);
  });
});
