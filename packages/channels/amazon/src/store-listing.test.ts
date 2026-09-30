import { describe, expect, it } from "vitest";
import {
  amazonStoreAddress,
  amazonStoreNavigation,
  amazonStoreSourceUrl,
} from "./store-address.js";
import { amazonStoreBrandScan, parseAmazonStoreListing } from "./store-listing.js";
import { savedPage } from "./testing/saved-pages.js";
import { asinOne, asinTwo, storeHome, storeShop, storeHtml } from "./testing/store-fakes.js";

describe("Store addresses and scoped tiles", () => {
  it("canonicalizes slug aliases, case and tracking to the page ID", () => {
    expect(
      amazonStoreSourceUrl(storeHome.replace("/page/", "/SomeBrand/page/") + "?ref_=test#nav"),
    ).toBe(storeHome);
    expect(amazonStoreAddress(storeHome.replace("/page/", "/SomeBrand/page/"))).toMatchObject({
      storeKey: "somebrand",
    });
  });

  it.each([
    "/",
    "/s?k=brand",
    "/stores/page/not-a-uuid",
    storeHome.replace("amazon.com", "amazon.com.evil.test"),
    storeHome.replace("https://", "http://"),
    storeHome.replace("https://", "https://user@"),
  ])("rejects non-Store address %s", (url) => {
    expect(() => amazonStoreSourceUrl(url)).toThrow(
      expect.objectContaining({ code: "BRAND_SCAN.URL" }),
    );
  });

  it("ignores external and explicitly different-store navigation", () => {
    expect(amazonStoreNavigation(storeShop.replace("/page/", "/Other/page/"), "own")).toBeNull();
    expect(amazonStoreNavigation("https://example.com/stores/page/x", null)).toBeNull();
    expect(amazonStoreNavigation(storeShop, "own")).toBe(storeShop);
  });

  it("reads only product tiles and Store navigation, deduplicating ASINs", () => {
    const html = storeHtml([asinOne, asinOne, asinTwo], [storeHome, storeShop]).replace(
      "</body>",
      `<a href="/dp/B000000099">Recommendation</a>
        <div data-asin="B000000098"></div><nav><a href="${storeShop}?outside=1">Other</a></nav></body>`,
    );
    const listing = parseAmazonStoreListing(html, storeHome);
    expect(listing.products.map((product) => product.listingId)).toEqual([asinOne, asinTwo]);
    expect(listing.navigation).toEqual([storeHome, storeShop]);
    expect(amazonStoreBrandScan.complete([listing])).toBe(false);
  });

  it("accepts tile product links without data attributes, including gp/product", () => {
    const html = storeHtml().replace(`data-asin="${asinOne}"`, "").replace("/dp/", "/gp/product/");
    expect(parseAmazonStoreListing(html, storeHome).products[0]?.listingId).toBe(asinOne);
  });

  it("refuses malformed product identities instead of silently losing a tile", () => {
    expect(() => parseAmazonStoreListing(storeHtml(["BAD"]), storeHome)).toThrow(
      expect.objectContaining({ code: "BRAND_SCAN.TILE_IDENTITY" }),
    );
  });

  it("refuses challenges and missing Store navigation", () => {
    expect(() =>
      parseAmazonStoreListing("<html><body>Continue shopping</body></html>", storeHome),
    ).toThrow(expect.objectContaining({ code: "BRAND_SCAN.ACCESS_CHALLENGE" }));
    expect(() => parseAmazonStoreListing("<html><body>Loading</body></html>", storeHome)).toThrow(
      expect.objectContaining({ code: "AMAZON.STORE_UNVERIFIED" }),
    );
  });
});

// No Store HTML existed in docs/quality/evidence or apps/v3-workers during R19. An external
// amazon-store.html or this known repository-relative path enables the real-page regression.
const saved = savedPage("docs/quality/evidence/2026-09-23-shop-all-check/amazon-store.html");
describe.skipIf(!saved.available)(saved.name, () => {
  it("reads product tiles and navigation from a real saved Store page", () => {
    const listing = parseAmazonStoreListing(saved.read().html, storeHome);
    expect(listing.products.length).toBeGreaterThan(0);
    expect(listing.navigation.length).toBeGreaterThan(0);
    expect(listing.products.every((product) => /^[A-Z0-9]{10}$/.test(product.listingId))).toBe(
      true,
    );
  });
});

const brands = savedPage("docs/quality/evidence/2026-09-24-brand-final-status.json");
describe.skipIf(!brands.available)(brands.name, () => {
  it("accepts all 498 recorded Store source addresses", () => {
    const records = JSON.parse(brands.read().html) as Record<
      string,
      { state: string; url?: string }
    >;
    const stores = Object.values(records).filter((record) => record.state === "store-link");
    expect(stores).toHaveLength(498);
    for (const store of stores) {
      expect(amazonStoreSourceUrl(store.url ?? "")).toMatch(
        /^https:\/\/www\.amazon\.com\/stores\/page\//,
      );
    }
  });
});
