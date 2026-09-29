import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { wholeFoodsAdapter } from "./whole-foods-adapter.js";
import {
  wholeFoodsBrandSearchUrl,
  wholeFoodsBrandSourceUrl,
  wholeFoodsProductAddress,
} from "./whole-foods-address.js";
import { parseWholeFoodsListing } from "./whole-foods-listing.js";
import { parseWholeFoodsProduct } from "./whole-foods-product.js";
import type { WholeFoodsStore } from "./whole-foods-store.js";

// Synthetic pages built from the 2026-09-28 checks; see fixtures/README.md.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const store: WholeFoodsStore = { storeId: "10259", label: "The Alameda", postalCode: "95126" };
const productUrl =
  "https://www.wholefoodsmarket.com/grocery/product/nordic-naturals-nordic-naturals-omega-3-liquid-1560mg-fish-oil-epa-dha-lemon-flavor-8oz-b0096m5pbw";
const page = (name: string) => ({
  url: productUrl,
  html: fixture(name),
  capturedAt: "2026-09-30T08:00:00.000Z",
});

describe("Whole Foods addresses", () => {
  it("keys a product by its Amazon ASIN and drops the query", () => {
    expect(wholeFoodsProductAddress(`${productUrl}?fpw=alm`)).toEqual({
      url: productUrl,
      listingId: "B0096M5PBW",
      variantId: null,
    });
  });

  it.each([
    "https://www.amazon.com/grocery/product/x-b0096m5pbw",
    "https://www.wholefoodsmarket.com/grocery/search?k=x",
    "https://www.wholefoodsmarket.com/grocery/product/no-asin-here",
  ])("refuses %s", (url) => {
    expect(() => wholeFoodsProductAddress(url)).toThrow(
      expect.objectContaining({ code: "WHOLEFOODS.URL" }),
    );
  });

  it("builds and normalises a brand search filtered by the Amazon brand ID", () => {
    const url = wholeFoodsBrandSearchUrl({ name: "Nordic Naturals", amazonBrandId: "234060" });
    expect(url).toBe(
      "https://www.wholefoodsmarket.com/grocery/search?k=Nordic+Naturals&rh=p_123%3A234060",
    );
    expect(wholeFoodsBrandSourceUrl(url)).toBe(url);
    expect(() =>
      wholeFoodsBrandSourceUrl("https://www.wholefoodsmarket.com/grocery/search?k=Nordic"),
    ).toThrow();
  });
});

describe("Whole Foods product page", () => {
  it("reads the title, price and availability for the configured store", () => {
    expect(parseWholeFoodsProduct(page("product-b0096m5pbw.html"), store)).toMatchObject({
      asin: "B0096M5PBW",
      title: "Nordic Naturals Omega-3 Liquid 1560mg Fish Oil EPA DHA, Lemon Flavor, 8oz",
      price: "$24.21",
      availability: "available",
      storeId: "10259",
    });
  });

  it("records a product the store does not sell as unavailable, without a price", () => {
    expect(parseWholeFoodsProduct(page("product-unavailable.html"), store)).toMatchObject({
      price: null,
      availability: "unavailable",
    });
  });

  it("refuses a page priced for another store", () => {
    expect(() => parseWholeFoodsProduct(page("product-other-store.html"), store)).toThrow(
      expect.objectContaining({ code: "WHOLEFOODS.STORE_MISMATCH" }),
    );
  });

  it("gives the shared pipeline metrics with the store ID and no facts (the formula is Amazon's)", () => {
    const adapter = wholeFoodsAdapter(store);
    const parsed = adapter.parseProduct(page("product-b0096m5pbw.html"));
    expect(adapter.captureModes).toEqual(["browser"]);
    expect(parsed.identity).toEqual({ listingId: "B0096M5PBW", variantId: null });
    expect(parsed.commerce).toMatchObject({ price: "$24.21", priceStatus: "observed" });
    expect(parsed.commerce?.context).toContain("wholefoods-store:10259");
    expect(parsed.facts).toEqual({
      text: null,
      complete: false,
      missing: ["FACTS.FROM_AMAZON_BY_ASIN"],
    });
    expect(parsed.evidence.channel).toBe("wholefoods");
  });
});

describe("Whole Foods brand search page", () => {
  it("lists each ASIN once, in page order", () => {
    const listing = parseWholeFoodsListing(fixture("search-nordic-naturals.html"), store);
    expect(listing.page.products.map((product) => product.listingId)).toEqual([
      "B002CQU54Q",
      "B07WMZTX28",
      "B0096M5PBW",
    ]);
    expect(listing).toMatchObject({ soldHere: true, page: { cards: 3, nextPage: null } });
  });

  it("reads a no-results search as a brand not sold at this store", () => {
    expect(parseWholeFoodsListing(fixture("search-no-results.html"), store)).toMatchObject({
      soldHere: false,
      page: { products: [] },
    });
  });

  it("never reads a page that drew nothing as an empty brand", () => {
    expect(() => parseWholeFoodsListing(fixture("search-not-loaded.html"), store)).toThrow(
      expect.objectContaining({ code: "WHOLEFOODS.LISTING_UNVERIFIED" }),
    );
  });

  it("refuses a product tile without a readable ASIN", () => {
    const html = fixture("search-nordic-naturals.html").replace("b07wmztx28", "not-an-asin");
    expect(() => parseWholeFoodsListing(html, store)).toThrow(
      expect.objectContaining({ code: "BRAND_SCAN.TILE_IDENTITY" }),
    );
  });
});
