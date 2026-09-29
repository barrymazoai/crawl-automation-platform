import { describe, expect, it } from "vitest";
import { swansonBrandScan } from "./brand-scan.js";

const source = "https://www.swansonvitamins.com/collections/brand-healthy-origins";
/** Shopify collection JSON, in the shape the 09-28 Healthy Origins scan read (ids, handles, variants). */
const products = (count: number, from = 0) =>
  JSON.stringify({
    products: Array.from({ length: count }, (_, index) => ({
      id: 7_000_000_000 + from + index,
      handle: `healthy-origins-product-${from + index}`,
      title: `Healthy Origins product ${from + index}`,
      variants: [{ id: 46_000_000 + from + index, sku: `HO${from + index}`, available: true }],
    })),
  });

describe("Swanson brand scan (Shopify products.json)", () => {
  it("builds the collection JSON address of 250 products per page", () => {
    expect(swansonBrandScan.pageUrl(source, 2)).toBe(
      "https://www.swansonvitamins.com/collections/brand-healthy-origins/products.json?limit=250&page=2",
    );
  });

  it("lists each size as its own product, keyed by its handle", () => {
    const page = swansonBrandScan.parsePage({ body: products(65), url: source, page: 1 });
    expect(page.cards).toBe(65);
    expect(page.products[0]).toEqual({
      url: "https://www.swansonvitamins.com/p/healthy-origins-product-0",
      listingId: "healthy-origins-product-0",
      variantId: null,
      title: "Healthy Origins product 0",
      kind: "product",
    });
  });

  it("goes on after a full page and is complete after a shorter one", () => {
    const first = swansonBrandScan.parsePage({ body: products(250), url: source, page: 1 });
    const last = swansonBrandScan.parsePage({ body: products(3, 250), url: source, page: 2 });
    expect([first.nextPage, last.nextPage]).toEqual([2, null]);
    expect(swansonBrandScan.complete([first])).toBe(false);
    expect(swansonBrandScan.complete([first, last])).toBe(true);
  });

  it.each([
    ["<html>Just a moment…</html>", "BRAND_SCAN.ACCESS_CHALLENGE"],
    ['{"items":[]}', "BRAND_SCAN.NOT_JSON"],
    [
      JSON.stringify({ products: [{ id: "x", handle: "Bad Handle", variants: [] }] }),
      "BRAND_SCAN.TILE_IDENTITY",
    ],
  ])("refuses an unreadable answer (%s)", (body, code) => {
    expect(() => swansonBrandScan.parsePage({ body, url: source, page: 1 })).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("refuses a source that is not a Swanson brand collection", () => {
    expect(() =>
      swansonBrandScan.sourceUrl("https://www.swansonvitamins.com/p/healthy-origins-x"),
    ).toThrow(expect.objectContaining({ code: "BRAND_SCAN.URL" }));
  });
});
