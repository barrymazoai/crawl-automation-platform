import { describe, expect, it } from "vitest";
import { swansonAdapter } from "./adapter.js";
import { createSwansonBrandScan } from "./brand-scan.js";
import { swansonCollectionTitle } from "./collection-page.js";
import { SwansonBrandScanSettingsSchema } from "./brand-scan-settings.js";

const source = "https://www.swansonvitamins.com/collections/brand-herb-pharm";
const reader = createSwansonBrandScan({ constructorKey: "test-public-key" });
const title = '<constructor-plp data-collection-title="Herb Pharm"></constructor-plp>';
function resolution(brandName?: string) {
  const step = reader.resolve?.({ url: source, brandName });
  if (!step || !("request" in step)) {
    throw new Error("expected a resolution request");
  }
  return step;
}
function resolveTitle(body: string) {
  const resolved = resolution().parsePage({ body, url: source });
  if ("request" in resolved) {
    throw new Error("expected a resolved collection title");
  }
  return resolved;
}
const base = resolveTitle(title).sourceUrl;

// Small hand-written shapes; generated card counts exercise the real 100-card page boundary.
function card(handle: string, variations: string[] = []) {
  return {
    value: "Whole Root Rhodiola",
    data: { id: `sku-${handle}`, url: handle },
    variations: variations.map((url) => ({ data: { url } })),
  };
}
const cards = (count: number, prefix = "item") =>
  Array.from({ length: count }, (_, index) => card(`${prefix}-${index}`));
const body = (results: unknown[], total = results.length) =>
  JSON.stringify({ response: { total_num_results: total, results } });
const parse = (response: string, page = 1) =>
  reader.parsePage({ body: response, url: reader.pageUrl(base, page), page });

describe("Swanson collection resolution", () => {
  it("reads the exact facet title from the empty server shell, decoding entities", () => {
    expect(swansonCollectionTitle(`<main>${title}</main><script>throw 1</script>`)).toBe(
      "Herb Pharm",
    );
    const encoded = title.replace("Herb Pharm", " A &amp; B / C ");
    expect(swansonCollectionTitle(encoded)).toBe("A & B / C");
    const resolved = resolveTitle(encoded);
    expect(new URL(resolved.sourceUrl).pathname).toBe("/browse/brand/A%20%26%20B%20%2F%20C");
    expect(resolved.nameResolution).toEqual({ brandName: "A & B / C", usedFallback: true });
  });

  it.each([
    "<main><h1>Herb Pharm</h1><constructor-plp></constructor-plp></main>",
    '<constructor-plp data-collection-title=" "></constructor-plp>',
    `${title}<constructor-plp data-collection-title="Other"></constructor-plp>`,
    '{"products":[]}',
  ])("refuses a missing or ambiguous title instead of declaring an empty scan", (html) => {
    expect(() => swansonCollectionTitle(html)).toThrow(
      expect.objectContaining({ code: "SWANSON.COLLECTION_TITLE_MISSING" }),
    );
  });

  it.each(["__shopify_bv_challenge", "cf-chl", "Just a moment", "Attention Required"])(
    "recognises a challenge shell: %s",
    (challenge) => {
      expect(() => swansonCollectionTitle(`<html>${challenge}</html>`)).toThrow(
        expect.objectContaining({ code: "BRAND_SCAN.ACCESS_CHALLENGE" }),
      );
    },
  );

  it("requires configuration before paying for even the resolution page", () => {
    expect(() => createSwansonBrandScan().resolve?.({ url: source })).toThrow(
      expect.objectContaining({ code: "SWANSON.CONSTRUCTOR_KEY_MISSING" }),
    );
    expect(SwansonBrandScanSettingsSchema.safeParse({ constructorKey: " " }).success).toBe(false);
    expect(SwansonBrandScanSettingsSchema.safeParse({ constructorKey: 123 }).success).toBe(false);
  });

  it("normalises legacy JSON URLs and builds bounded brand-facet API pages", () => {
    expect(reader.sourceUrl(`${source}/products.json?limit=250`)).toBe(source);
    expect(resolution().request.url).toBe(source);
    const url = new URL(reader.pageUrl(base, 2));
    expect(url.origin).toBe("https://ac.cnstrc.com");
    expect(url.pathname).toBe("/browse/brand/Herb%20Pharm");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      key: "test-public-key",
      page: "2",
      num_results_per_page: "100",
    });
    expect(reader.answer).toBe("json");
    expect(resolution().request.answer).toBe("html");
    expect(reader.maxPages).toBe(250);
    expect(reader.maxBytes).toBe(8 * 1024 * 1024);
    expect(resolution().request.maxBytes).toBe(6 * 1024 * 1024);
    for (const page of [0, -1, 1.5, 251]) {
      expect(() => reader.pageUrl(base, page)).toThrow(
        expect.objectContaining({ code: "BRAND_SCAN.URL" }),
      );
    }
  });

  it.each([
    "https://evil.example/collections/brand-test",
    `${source}/p/x`,
    "https://user@www.swansonvitamins.com/collections/brand-test",
  ])("refuses an unrelated source: %s", (url) => {
    expect(() => reader.sourceUrl(url)).toThrow(
      expect.objectContaining({ code: "BRAND_SCAN.URL" }),
    );
  });
});

describe("stored Swanson name resolution", () => {
  it("preserves the stored name and uses its matching response as page one", () => {
    const brandName = "A & B® / C Inc.";
    const step = resolution(brandName);
    expect(step.request).toMatchObject({ label: "resolve-name", answer: "json" });
    expect(new URL(step.request.url).pathname).toBe(
      `/browse/brand/${encodeURIComponent(brandName)}`,
    );
    expect(step.parsePage({ body: body([card("one")]), url: step.request.url })).toMatchObject({
      sourceUrl: step.request.url,
      firstPage: { cards: 1, pageNumber: 1, statedTotal: 1 },
      nameResolution: { brandName, usedFallback: false },
    });
  });

  it("uses the collection only after an explicit zero total", () => {
    const step = resolution("Stored Name");
    const next = step.parsePage({ body: body([]), url: step.request.url });
    expect(next).toMatchObject({ request: { url: source, label: "resolve", answer: "html" } });
    expect(() => step.parsePage({ body: "{}", url: step.request.url })).toThrow(
      expect.objectContaining({ code: "BRAND_SCAN.NOT_JSON" }),
    );
    expect(step.parsePage({ body: body([], 1), url: step.request.url })).toHaveProperty(
      "firstPage",
    );
  });
});

describe("Constructor products", () => {
  it("lists cards and sizes as products, deduping handles and matching capture identity", () => {
    const page = parse(
      body([card("small", ["small", "large", "large"]), card("other", ["large"])]),
    );
    expect(page).toMatchObject({ cards: 2, cardIds: ["sku-small", "sku-other"], statedTotal: 2 });
    expect(page.products.map((item) => item.listingId)).toEqual(["small", "large", "other"]);
    for (const product of page.products) {
      expect(product).toMatchObject({ kind: "product", variantId: null });
      expect(swansonAdapter.productAddress(product.url)).toEqual({
        url: product.url,
        listingId: product.listingId,
        variantId: product.variantId,
      });
    }
    expect(reader.complete([page])).toBe(true);
    expect(reader.familyMembers).toBeUndefined();
  });

  it("accepts cards with no variations field", () => {
    const page = parse(body([{ value: "Herb", data: { url: "herb", id: "HPH001" } }]));
    expect(page.products).toHaveLength(1);
    expect(page.products[0]?.listingId).toBe("herb");
  });

  it.each([
    "not json",
    "{}",
    body([{}]),
    body([card("../wrong")]),
    body([{ ...card("small"), variations: [{ data: {} }] }]),
    body([card("small")], -1),
    body([], 1.5),
    body(cards(101)),
    JSON.stringify({ response: { total_num_results: "1", results: [] } }),
  ])("rejects malformed external JSON without returning an empty scan", (response) => {
    expect(() => parse(response)).toThrow(expect.objectContaining({ code: "BRAND_SCAN.NOT_JSON" }));
  });
});

describe("Constructor completeness", () => {
  const first = () => parse(body(cards(100), 101));
  const last = () => parse(body([card("last")], 101), 2);

  it("follows the stated total and requires every page exactly once", () => {
    expect(first().nextPage).toBe(2);
    expect(last().nextPage).toBeNull();
    expect(reader.complete([first(), last()])).toBe(true);
    for (const pages of [[], [first()], [last()], [last(), first()], [first(), first(), last()]]) {
      expect(reader.complete(pages)).toBe(false);
    }
  });

  it("makes truncated, changing, duplicate and excessive card counts partial", () => {
    expect(reader.complete([parse(body(cards(99), 101)), last()])).toBe(false);
    expect(reader.complete([first(), parse(body([card("last")], 102), 2)])).toBe(false);
    expect(reader.complete([first(), parse(body([card("item-0")], 101), 2)])).toBe(false);
    expect(reader.complete([parse(body([card("same"), card("same")], 2))])).toBe(false);
    expect(reader.complete([parse(body(cards(2), 1))])).toBe(false);
    expect(reader.complete([parse(body([], 1))])).toBe(false);
  });

  it("accepts explicit zero and exact 100-card exhaustion without an extra request", () => {
    expect(reader.complete([parse(body([]))])).toBe(true);
    const page = parse(body(cards(100)));
    expect(page.nextPage).toBeNull();
    expect(reader.complete([page])).toBe(true);
  });

  it("stops at the page cap as partial, even if the capped page is populated", () => {
    const page = parse(body(cards(100), 25_001), 250);
    expect(page).toMatchObject({ capped: true, nextPage: null });
    expect(reader.complete([page])).toBe(false);
  });
});
