import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { gncProductAddress } from "./gnc-address.js";
import { gncAdapter } from "./gnc-adapter.js";

const html = gunzipSync(
  readFileSync(new URL("./fixtures/product-877080.html.gz", import.meta.url)),
).toString("utf8");
const page = {
  url: "https://www.gnc.com/vitamin-d/877080.html",
  html,
  capturedAt: "2026-09-28T12:00:00.000Z",
};

describe("GNC adapter on the real 877080 page", () => {
  const parsed = gncAdapter.parseProduct(page);

  it("reads the product's identity, title and brand from the page", () => {
    expect(parsed.identity).toEqual({ listingId: "877080", variantId: null });
    expect(parsed.evidence).toMatchObject({
      channel: "gnc",
      listingId: "877080",
      title: "Omega Plant Based D3+K2 (30 Servings)",
      brandRaw: "Nordic Naturals®",
    });
    expect(parsed.evidence.imageCandidates.length).toBeGreaterThan(0);
  });

  it("reports the page's own SKU even when another listing was requested", () => {
    const other = { ...page, url: "https://www.gnc.com/vitamin-d/123456.html" };
    expect(gncAdapter.pageIdentity?.(other)).toEqual({ listingId: "877080", variantId: null });
    expect(gncAdapter.parseProduct(other).identity).toEqual(parsed.identity);
  });

  it("records the metrics the page shows", () => {
    expect(parsed.commerce).toMatchObject({
      sku: "877080",
      price: "53.99",
      currency: "USD",
      rating: "5.0",
      reviewCount: "2",
      availability: "instock",
      priceStatus: "observed",
    });
  });

  it("takes the complete facts table as the formula text (html-table-first/1)", () => {
    expect(parsed.facts.complete).toBe(true);
    expect(parsed.facts.missing).toEqual([]);
    expect(parsed.facts.text).toMatch(/Serving Size/i);
    expect(parsed.facts.text).toMatch(/Other Ingredients/i);
  });
});

describe("GNC product addresses", () => {
  it("keeps the page path and takes the page ID as the listing", () => {
    expect(gncProductAddress("https://gnc.com/vitamin-d/877080.html?utm=x#top")).toEqual({
      url: "https://www.gnc.com/vitamin-d/877080.html",
      listingId: "877080",
      variantId: null,
    });
  });

  it.each([
    "https://www.example.com/vitamin-d/877080.html",
    "https://www.gnc.com/on/demandware.store/Sites-GNC2-Site/default/Product-Show?pid=877080",
    "https://www.gnc.com/brands/gnc/",
  ])("refuses %s", (url) => {
    expect(() => gncProductAddress(url)).toThrow(
      expect.objectContaining({ code: "GNC.URL_REJECTED" }),
    );
  });

  it("never captures a family page as one product", () => {
    const family = { ...page, url: "https://www.gnc.com/protein/GNCTotalLeanLeanShake12Pack.html" };
    expect(() => gncAdapter.parseProduct(family)).toThrow(
      expect.objectContaining({ code: "GNC.FAMILY_PAGE" }),
    );
  });
});
