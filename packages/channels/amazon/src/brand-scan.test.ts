import { describe, expect, it } from "vitest";
import { amazonAdapter, amazonBrandScan } from "./index.js";
import {
  FILTERED_SEARCH_URL,
  filteredSearch,
  pagedSearch,
  searchDocument,
  unfilteredSearch,
} from "./testing/saved-search-pages.js";

const parse = (body: string, page = 1) =>
  amazonBrandScan.parsePage({
    body,
    url: amazonBrandScan.pageUrl(FILTERED_SEARCH_URL, page),
    page,
  });
const cardSelector = 'div.s-main-slot > div[data-component-type="s-search-result"][data-asin]';

describe("Amazon brand scan addresses", () => {
  it("registers an HTML reader with seven pages and preserves the verified Brand scope", () => {
    expect(amazonAdapter.brandScan).toBe(amazonBrandScan);
    expect(amazonBrandScan).toMatchObject({ answer: "html", maxPages: 7 });
    for (let page = 1; page <= 7; page++) {
      const url = new URL(amazonBrandScan.pageUrl(`${FILTERED_SEARCH_URL}&ref=tracking`, page));
      expect(url.pathname).toBe("/s");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        k: "Herb Pharm",
        i: "hpc",
        rh: "n:3760901,p_123:383950",
        dc: "",
        s: "date-desc-rank",
        page: String(page),
      });
    }
  });

  it("keeps brand-page srs/p_89 and resets existing sort, paging and tracking", () => {
    const url = amazonBrandScan.sourceUrl(
      "https://www.amazon.com/s?srs=123456&rh=p_89%3ANordic+Naturals&page=5&s=featured&ref=abc",
    );
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
      srs: "123456",
      rh: "p_89:Nordic Naturals",
      s: "date-desc-rank",
    });
  });

  it.each([0, 8, -1, 1.5, NaN])("rejects page %s before fetching", (page) => {
    expect(() => amazonBrandScan.pageUrl(FILTERED_SEARCH_URL, page)).toThrow(
      expect.objectContaining({ code: "BRAND_SCAN.URL" }),
    );
  });

  it.each([
    "https://www.amazon.com/",
    "https://www.amazon.com/stores/page/123",
    "https://www.amazon.com/dp/B0016B5U20",
    "https://www.amazon.com/s?k=Herb+Pharm",
    "https://www.amazon.com/s?rh=p_6%3A383950",
    "https://www.amazon.com/s?rh=p_123%3A1,p_123%3A2",
    "https://www.amazon.com/s?rh=p_123%3A1,p_6%3A2",
    "https://evil.example/s?rh=p_89%3AHerb",
    "https://user:pass@www.amazon.com/s?rh=p_89%3AHerb",
    "https://www.amazon.com/s?srs=bad&rh=p_89%3AHerb",
    "https://www.amazon.com/s?srs=123&rh=p_123%3A383950",
    "https://www.amazon.com/s?srs=123&rh=p_89%3AHerb&k=Herb",
  ])("rejects non-brand search scope: %s", (url) => {
    expect(() => amazonBrandScan.sourceUrl(url)).toThrow(
      expect.objectContaining({ code: "BRAND_SCAN.URL" }),
    );
  });
});

describe.skipIf(!filteredSearch.available)(filteredSearch.name, () => {
  it("reads a brand-page shape without requiring the search-only Brand checkbox", () => {
    const document = searchDocument();
    document.getElementById("p_123/383950")?.remove();
    const source = "https://www.amazon.com/s?srs=123&rh=p_89%3AHerb+Pharm";
    document.querySelector("a.s-pagination-next")?.setAttribute("href", `${source}&page=2`);
    const result = amazonBrandScan.parsePage({
      body: document.toString(),
      url: amazonBrandScan.pageUrl(source, 1),
      page: 1,
    });
    expect(result).toMatchObject({ cards: 24, nextPage: 2, capped: false });
  });

  it("reads all 24 real organic cards, including the full product title and decoded ampersand", () => {
    const result = parse(filteredSearch.read().html);
    expect(result).toMatchObject({ cards: 24, nextPage: 2, statedTotal: 341, capped: false });
    expect(result.products).toHaveLength(24);
    expect(result.products[0]).toEqual({
      listingId: "B0016B5U20",
      url: "https://www.amazon.com/dp/B0016B5U20",
      variantId: null,
      kind: "product",
      title:
        "Kava Root Liquid Extract: Reduces Stress, Relaxing, Vegan, Non-GMO Kava Kava " +
        "Tincture for Calm & Relaxed Mind, Made with Noble Kava, Gluten-Free, Up to 3 Month Supply, 4 oz",
    });
    expect(result.products[4]?.title).toContain("Milk Thistle Supplement & Dandelion Extract");
    expect(result.products.at(-1)?.listingId).toBe("B001E8L0XI");
    expect(amazonBrandScan.complete([result])).toBe(false);
  });

  it.each([
    '<span data-component-type="s-sponsored-label-marker"></span>',
    '<span class="puis-sponsored-label-text"></span>',
    "<span>Sponsored</span>",
    '<a href="/sspa/click"></a>',
    '<a href="https://sponsored-ads.amazon.com/a"></a>',
    '<span class="ad-feedback"></span>',
    '<a href="/ad-feedback/report"></a>',
  ])("filters a real card with injected ad marker: %s", (marker) => {
    const document = searchDocument();
    document.querySelector(cardSelector)?.insertAdjacentHTML("beforeend", marker);
    const result = parse(document.toString());
    expect(result.cards).toBe(23);
    expect(result.products.some((product) => product.listingId === "B0016B5U20")).toBe(false);
  });

  it("excludes AdHolder cards, nested recommendations and cards outside the main grid", () => {
    const document = searchDocument();
    const cards = [...document.querySelectorAll(cardSelector)];
    cards[0]?.classList.add("AdHolder");
    const wrapper = document.createElement("div");
    if (cards[1] && cards[2]) {
      cards[1].replaceWith(wrapper);
      wrapper.append(cards[1]);
      document.body.append(cards[2]);
    }
    const result = parse(document.toString());
    expect(result.cards).toBe(21);
    expect(result.products[0]?.listingId).toBe("B0199RDWOK");
  });

  it("deduplicates ASINs while retaining the physical organic card count", () => {
    const document = searchDocument();
    const card = document.querySelector(cardSelector);
    card?.parentElement?.append(card.cloneNode(true));
    expect(parse(document.toString())).toMatchObject({ cards: 25, products: expect.any(Array) });
    expect(parse(document.toString()).products).toHaveLength(24);
  });

  it("stops on an empty page even if a next link remains", () => {
    const result = parse(pagedSearch({ page: 2, empty: true }), 2);
    expect(result).toMatchObject({ cards: 0, products: [], nextPage: null, capped: false });
    expect(amazonBrandScan.complete([parse(filteredSearch.read().html), result])).toBe(true);
  });

  it("stops without a next link and does not treat the stated total as completeness proof", () => {
    const result = parse(pagedSearch({ page: 2, last: true }), 2);
    expect(result).toMatchObject({ cards: 24, statedTotal: 341, nextPage: null, capped: false });
    expect(amazonBrandScan.complete([result])).toBe(true);
  });

  it.each([false, true])("caps a full page 7, whether the next link is absent: %s", (last) => {
    const result = parse(pagedSearch({ page: 7, last }), 7);
    expect(result).toMatchObject({ cards: 24, nextPage: null, capped: true });
    expect(amazonBrandScan.complete([result])).toBe(false);
  });

  it("does not cap an empty page 7", () => {
    const result = parse(pagedSearch({ page: 7, empty: true }), 7);
    expect(result).toMatchObject({ capped: false, nextPage: null });
    expect(amazonBrandScan.complete([result])).toBe(true);
  });

  it("keeps a full seventh page capped even when filtering adverts reduces its organic count", () => {
    const document = searchDocument();
    document.querySelector(cardSelector)?.classList.add("AdHolder");
    document.querySelector(".s-pagination-selected")?.replaceChildren("7");
    document.querySelector("a.s-pagination-next")?.remove();
    document
      .querySelector('[data-component-type="s-result-info-bar"]')
      ?.replaceChildren("145-168 of 341 results");
    expect(parse(document.toString(), 7)).toMatchObject({
      cards: 23,
      nextPage: null,
      capped: true,
    });
  });

  it("recognizes a short terminal seventh page using its range, without hardcoding 48", () => {
    const document = searchDocument();
    [...document.querySelectorAll(cardSelector)].slice(6).forEach((card) => card.remove());
    document.querySelector(".s-pagination-selected")?.replaceChildren("7");
    document.querySelector("a.s-pagination-next")?.remove();
    document
      .querySelector('[data-component-type="s-result-info-bar"]')
      ?.replaceChildren("145-150 of 341 results");
    expect(parse(document.toString(), 7)).toMatchObject({
      cards: 6,
      nextPage: null,
      capped: false,
    });
  });

  it("refuses a repeated first page at page 2, missing pagination and a skipped next page", () => {
    expect(() => parse(filteredSearch.read().html, 2)).toThrow(
      expect.objectContaining({ code: "BRAND_SCAN.PAGINATION" }),
    );
    const document = searchDocument();
    document.querySelector(".s-pagination-selected")?.remove();
    expect(() => parse(document.toString(), 2)).toThrow(
      expect.objectContaining({ code: "BRAND_SCAN.PAGINATION" }),
    );
    document
      .querySelector("a.s-pagination-next")
      ?.setAttribute("href", `${FILTERED_SEARCH_URL}&page=3`);
    expect(() => parse(document.toString())).toThrow(
      expect.objectContaining({ code: "BRAND_SCAN.PAGINATION" }),
    );
  });

  it("refuses an unchecked Brand facet and a damaged organic ASIN", () => {
    const document = searchDocument();
    document.getElementById("p_123/383950")?.querySelector("input")?.removeAttribute("checked");
    expect(() => parse(document.toString())).toThrow(
      expect.objectContaining({ code: "AMAZON.SCAN_FILTER_LOST" }),
    );
    document.querySelector(cardSelector)?.setAttribute("data-asin", "bad");
    expect(() => parse(document.toString())).toThrow(
      expect.objectContaining({ code: "BRAND_SCAN.TILE_IDENTITY" }),
    );
  });

  it("does not interpret a missing result grid or robot check as a completed empty scan", () => {
    const document = searchDocument();
    document.querySelector("div.s-main-slot")?.remove();
    expect(() => parse(document.toString())).toThrow(
      expect.objectContaining({ code: "AMAZON.SCAN_UNVERIFIED" }),
    );
    document.querySelector("title")?.replaceChildren("Robot Check");
    expect(() => parse(document.toString())).toThrow(
      expect.objectContaining({ code: "CAPTURE.ACCESS_CHALLENGE" }),
    );
  });
});

describe.skipIf(!unfilteredSearch.available)(unfilteredSearch.name, () => {
  it("rejects the real keyword-only response when a Brand-filter search was requested", () => {
    expect(() => parse(unfilteredSearch.read().html)).toThrow(
      expect.objectContaining({ code: "AMAZON.SCAN_FILTER_LOST" }),
    );
  });
});
