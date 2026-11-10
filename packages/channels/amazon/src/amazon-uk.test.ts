import { describe, expect, it } from "vitest";
import { amazonAdapters, amazonInAdapter } from "./adapter.js";
import { amazonProductAddress } from "./address.js";
import { amazonBrandLookupUrl } from "./brand-lookup.js";
import { amazonSiteBrandScan } from "./brand-scan.js";
import { amazonBrandSearch } from "./brand-scan-address.js";
import { amazonCommerce } from "./commerce.js";
import { amazonDocument, productRoot } from "./dom.js";
import { parseAmazonProduct } from "./product.js";
import { AMAZON_IN, AMAZON_UK, AMAZON_US } from "./site.js";

// KAN-243: markup copied from real amazon.co.uk pages captured 2026-11-10 (Nutrition Geeks Magnesium Glycinate
// B0C9VVCL12); the saved pages themselves stay out of git (R2 research/kan243-geo/scraperapi/uk/).
const PRICE_TO_PAY = `<div id="corePriceDisplay_desktop_feature_div">
  <span id="apex-pricetopay-accessibility-label" class="aok-offscreen"> &pound;9.99 with 29 percent savings </span>
  <span class="a-price aok-align-center reinventPricePriceToPayMargin priceToPay apex-pricetopay-value"><span class="a-offscreen"> </span><span aria-hidden="true"><span class="a-price-symbol">£</span><span class="a-price-whole">9<span class="a-price-decimal">.</span></span><span class="a-price-fraction">99</span></span></span>
  <span class="a-size-small aok-offscreen"> <span class="a-offscreen">£0.11</span> per count </span>
  <span aria-hidden="true" class="a-size-small a-color-secondary aok-align-center basisPrice">RRP: <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">£13.99</span></span></span>
</div>`;
const location = (line: string) =>
  `<a id="nav-global-location-popover-link"><span id="glow-ingress-line1">${line}</span>
  <span id="glow-ingress-line2">Update location</span></a>`;
const TITLE = `<span id="productTitle">Magnesium Glycinate 3-in-1 Complex</span>`;

function html(asin: string, line: string | null) {
  return `<html><body>${line === null ? "" : location(line)}<div id="ppd"><input id="ASIN" value="${asin}">${TITLE}${PRICE_TO_PAY}</div></body></html>`;
}

const capturedAt = "2026-11-10T09:00:00.000Z";

describe("amazon.co.uk storefront", () => {
  it("reads the price to pay in pounds, the RRP as list price and the delivery postcode", () => {
    const root = productRoot(amazonDocument(html("B0C9VVCL12", "Delivering to London SW1A")));
    const commerce = amazonCommerce(root, "B0C9VVCL12", AMAZON_UK);
    expect(commerce).toMatchObject({
      price: "9.99",
      currency: "GBP",
      listPrice: "13.99",
      priceStatus: "observed",
    });
    // amazon.co.uk pages print no "Date First Available" line at all.
    expect(commerce.dateFirstAvailable?.date ?? null).toBeNull();
    expect(commerce.purchaseConditions?.delivery.postalCode).toBe("SW1A");
    for (const [line, code] of [
      ["Delivering to London E177QZ", "E177QZ"],
      ["Delivering to Rickmansw... WD3", "WD3"],
      ["Delivering to City Of L... EC4N", "EC4N"],
      ["Delivering to Exeter EX1", "EX1"],
    ] as const) {
      const at = productRoot(amazonDocument(html("B0C9VVCL12", line)));
      expect(
        amazonCommerce(at, "B0C9VVCL12", AMAZON_UK).purchaseConditions?.delivery.postalCode,
      ).toBe(code);
    }
  });

  it("keeps the storefront's addresses to its own host", () => {
    expect(
      amazonProductAddress(
        "https://www.amazon.co.uk/Nutrition-Geeks/dp/b0c9vvcl12?th=1",
        AMAZON_UK,
      ),
    ).toEqual({
      url: "https://www.amazon.co.uk/dp/B0C9VVCL12",
      listingId: "B0C9VVCL12",
      variantId: null,
    });
    expect(() => amazonProductAddress("https://www.amazon.com/dp/B0C9VVCL12", AMAZON_UK)).toThrow();
    expect(() =>
      amazonProductAddress("https://www.amazon.co.uk/dp/B0C9VVCL12", AMAZON_IN),
    ).toThrow();
  });

  it("is its own channel with its own formula family, parser version, HTTP origin and India's label formats", () => {
    expect(amazonAdapters.map((adapter) => adapter.id)).toEqual([
      "amazon",
      "amazon-in",
      "amazon-uk",
    ]);
    expect(amazonAdapters[1]).toBe(amazonInAdapter);
    expect(amazonAdapters[2]).toMatchObject({
      id: "amazon-uk",
      formulaFamily: "amazon-uk-asin",
      httpPolicy: { origins: ["https://www.amazon.co.uk"] },
      planning: {
        channel: "amazon-uk",
        parserVersion: "amazon-uk-rendered/1",
        projectionModule: "amazon-uk.http-projection",
      },
    });
    expect(amazonAdapters[2]?.productUrl?.("b0c9vvcl12")).toBe(
      "https://www.amazon.co.uk/dp/B0C9VVCL12",
    );
  });
});

describe("a storefront page delivered to another country (KAN-243, 2026-11-10)", () => {
  const url = "https://www.amazon.co.uk/dp/B0C9VVCL12";

  it("is a Review on amazon.co.uk, never read as an unavailable product", () => {
    expect(
      parseAmazonProduct(
        { url, html: html("B0C9VVCL12", "Delivering to London SW1A"), capturedAt },
        AMAZON_UK,
      ),
    ).toMatchObject({ channel: "amazon-uk", identity: { listingId: "B0C9VVCL12" } });
    for (const line of ["Deliver to South Africa", "Deliver to Germany"]) {
      expect(() =>
        parseAmazonProduct({ url, html: html("B0C9VVCL12", line), capturedAt }, AMAZON_UK),
      ).toThrow(expect.objectContaining({ code: "AMAZON.DELIVERY_ABROAD" }));
    }
  });

  it("reads an amazon.in page without a location line as before, and one with an Indian postcode", () => {
    const inUrl = "https://www.amazon.in/dp/B006CRGT5K";
    expect(
      parseAmazonProduct({ url: inUrl, html: html("B006CRGT5K", null), capturedAt }, AMAZON_IN)
        .channel,
    ).toBe("amazon-in");
    expect(
      parseAmazonProduct(
        { url: inUrl, html: html("B006CRGT5K", "Delivering to Mumbai 400017"), capturedAt },
        AMAZON_IN,
      ).channel,
    ).toBe("amazon-in");
    expect(() =>
      parseAmazonProduct(
        { url: inUrl, html: html("B006CRGT5K", "Deliver to South Africa"), capturedAt },
        AMAZON_IN,
      ),
    ).toThrow(expect.objectContaining({ code: "AMAZON.DELIVERY_ABROAD" }));
  });

  it("leaves amazon.com unchanged: its location line is never checked", () => {
    const usUrl = "https://www.amazon.com/dp/B0C9VVCL12";
    expect(
      parseAmazonProduct(
        { url: usUrl, html: html("B0C9VVCL12", "Deliver to South Africa"), capturedAt },
        AMAZON_US,
      ).channel,
    ).toBe("amazon");
  });
});

describe("amazon.co.uk brand search department (KAN-243, 2026-11-10)", () => {
  const reader = amazonSiteBrandScan(AMAZON_UK);
  // Page 1 of the Enzymedica scan as amazon.co.uk printed it: its next-page link names the department `drugstore`.
  const page = (selected: number, next: string) => `<html><body>
    <div id="p_123/23577"><input type="checkbox" checked></div>
    <div data-component-type="s-result-info-bar">1-48 of 61 results for "Enzymedica"</div>
    <div class="s-main-slot"><div data-component-type="s-search-result" data-asin="B0019LRY8A"><a href="/x/dp/B0019LRY8A"><h2>Enzymedica Digest Gold</h2></a></div></div>
    <span class="s-pagination-item s-pagination-selected">${selected}</span>
    <a href="${next}" role="button" aria-label="Go to next page, page 2" class="s-pagination-item s-pagination-next s-pagination-button">Next</a>
  </body></html>`;
  const next =
    "/s?k=Enzymedica&amp;i=drugstore&amp;rh=n%3A2826484031%2Cp_123%3A23577&amp;s=exact-aware-popularity-rank&amp;page=2&amp;xpid=ljb2lYJ5VByF2&amp;qid=1794312966&amp;ref=sr_pg_1";

  it("builds sources and lookups in the drugstore department; amazon.com and amazon.in keep hpc", () => {
    expect(amazonBrandSearch("Enzymedica", "23577", AMAZON_UK)).toBe(
      "https://www.amazon.co.uk/s?k=Enzymedica&i=drugstore&rh=n%3A2826484031%2Cp_123%3A23577&s=exact-aware-popularity-rank",
    );
    expect(new URL(amazonBrandLookupUrl("Enzymedica", AMAZON_UK)).searchParams.get("i")).toBe(
      "drugstore",
    );
    expect(new URL(amazonBrandSearch("Himalaya", "94291", AMAZON_IN)).searchParams.get("i")).toBe(
      "hpc",
    );
    expect(new URL(amazonBrandSearch("Himalaya", "94291", AMAZON_US)).searchParams.get("i")).toBe(
      "hpc",
    );
  });

  it("follows amazon.co.uk's next-page link from a drugstore source, as a scan of two pages", () => {
    const source = amazonBrandSearch("Enzymedica", "23577", AMAZON_UK);
    const first = reader.parsePage({
      body: page(1, next),
      url: reader.pageUrl(source, 1),
      page: 1,
    });
    expect(first).toMatchObject({ nextPage: 2 });
  });

  it("still refuses that link from a source asked in the hpc department (what 44 scans met)", () => {
    const source =
      "https://www.amazon.co.uk/s?k=Enzymedica&i=hpc&rh=n%3A2826484031%2Cp_123%3A23577&s=exact-aware-popularity-rank";
    expect(() =>
      reader.parsePage({ body: page(1, next), url: reader.pageUrl(source, 1), page: 1 }),
    ).toThrow(expect.objectContaining({ code: "BRAND_SCAN.PAGINATION" }));
  });
});
