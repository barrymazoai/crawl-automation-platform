import { describe, expect, it } from "vitest";
import { amazonAdapters } from "./adapter.js";
import { amazonProductAddress } from "./address.js";
import { amazonBrandLookupUrl } from "./brand-lookup.js";
import { amazonSiteBrandScan } from "./brand-scan.js";
import { amazonBrandSearch, amazonScanSourceUrl } from "./brand-scan-address.js";
import { amazonCommerce } from "./commerce.js";
import { amazonDocument, productRoot } from "./dom.js";
import { parseAmazonProduct } from "./product.js";
import { amazonSalesRank } from "./sales-rank.js";
import { AMAZON_DE, AMAZON_UK, AMAZON_US } from "./site.js";

// KAN-243: markup copied from the amazon.de page captured 2026-11-11 13:2x UTC for Doctor's Best PepZinGl B09LR81NNL
// (?language=en_GB, the one-time purchase selected; Subscribe & Save rows print their own lower prices, "€34.29 with 10
// percent savings", which are not the price). The archived page stays out of git (R2 v3/amazon-de-html/).
const PRICE_TO_PAY = `<div id="corePriceDisplay_desktop_feature_div"><div class="a-section apex-core-price-identifier">
  <span id="apex-pricetopay-accessibility-label" data-pricetopay-label="{priceToPay}" data-pricetopay-savings-label="{priceToPay} with {savings} percent savings" class="aok-offscreen"> €38.10 </span>
  <span class="a-price aok-align-center reinventPricePriceToPayMargin priceToPay apex-pricetopay-value" data-a-size="xl" data-a-color="base"><span class="a-offscreen"> </span><span aria-hidden="true"><span class="a-price-symbol">€</span><span class="a-price-whole">38<span class="a-price-decimal">.</span></span><span class="a-price-fraction">10</span></span></span>
</div></div>`;
const location = (line: string) =>
  `<a id="nav-global-location-popover-link"><span id="glow-ingress-line1">${line}</span>
  <span id="glow-ingress-line2">Update location</span></a>`;
const TITLE = `<span id="productTitle">Doctor's Best, PepZinGl, Zinc L-Carnosine Complex, 120 Vegan Capsules</span>`;
const DETAILS = `<table id="productDetails_detailBullets_sections1"><tr><th class="a-color-secondary a-size-base prodDetSectionEntry"> Best Sellers Rank </th> <td> <span> <ul class="a-unordered-list a-nostyle a-vertical">  <li><span class="a-list-item"><span>14,462 in Health & Personal Care (<a href='/-/en/gp/bestsellers/drugstore/ref=pd_zg_ts_drugstore'>See Top 100 in Health & Personal Care</a>)</span></span></li>  <li><span class="a-list-item"><span>58 in <a href='/-/en/gp/bestsellers/drugstore/2860565031/ref=pd_zg_hrsr_drugstore'>Zinc</a></span></span></li></ul></span></td></tr></table>`;

function html(asin: string, line: string | null) {
  return `<html><body>${line === null ? "" : location(line)}<div id="ppd"><input id="ASIN" value="${asin}">${TITLE}${PRICE_TO_PAY}</div><div id="prodDetails">${DETAILS}</div></body></html>`;
}

const capturedAt = "2026-11-11T12:00:00.000Z";

describe("amazon.de storefront (KAN-243, 2026-11-11)", () => {
  it("reads the one-time purchase price in euros and the delivery postcode", () => {
    const root = productRoot(amazonDocument(html("B09LR81NNL", "Delivering to Frankfurt 60313")));
    const commerce = amazonCommerce(root, "B09LR81NNL", AMAZON_DE);
    expect(commerce).toMatchObject({ price: "38.10", currency: "EUR", priceStatus: "observed" });
    expect(commerce.purchaseConditions?.delivery.postalCode).toBe("60313");
    for (const [line, code] of [
      ["Delivering to Frankfurt... 60313", "60313"],
      ["Delivering to Essen 45143", "45143"],
      ["Delivering to Straubing 94315", "94315"],
    ] as const) {
      const at = productRoot(amazonDocument(html("B09LR81NNL", line)));
      expect(
        amazonCommerce(at, "B09LR81NNL", AMAZON_DE).purchaseConditions?.delivery.postalCode,
      ).toBe(code);
    }
  });

  it("reads the Best Sellers Rank printed without a #", () => {
    expect(
      amazonSalesRank(amazonDocument(html("B09LR81NNL", "Delivering to Bonn 53175"))),
    ).toMatchObject({ rank: 14462, category: "Health & Personal Care" });
  });

  it("keeps the storefront's addresses to its own host, the English /-/en/ path included", () => {
    for (const raw of [
      "https://www.amazon.de/-/en/Doctors-PepZinGl-L-Carnosine-Laboratory-Vegetarian/dp/b09lr81nnl",
      "https://www.amazon.de/dp/B09LR81NNL?language=en_GB",
    ]) {
      expect(amazonProductAddress(raw, AMAZON_DE)).toEqual({
        url: "https://www.amazon.de/dp/B09LR81NNL",
        listingId: "B09LR81NNL",
        variantId: null,
      });
    }
    expect(() => amazonProductAddress("https://www.amazon.com/dp/B09LR81NNL", AMAZON_DE)).toThrow();
    expect(() => amazonProductAddress("https://www.amazon.de/dp/B09LR81NNL", AMAZON_UK)).toThrow();
  });

  it("is its own channel whose product pages are asked in English, the canonical address kept", () => {
    const adapter = amazonAdapters[4];
    expect(adapter).toMatchObject({
      id: "amazon-de",
      formulaFamily: "amazon-de-asin",
      httpPolicy: { origins: ["https://www.amazon.de"], query: { language: "en_GB" } },
      planning: {
        channel: "amazon-de",
        parserVersion: "amazon-de-rendered/1",
        projectionModule: "amazon-de.http-projection",
      },
    });
    expect(adapter?.productUrl?.("b09lr81nnl")).toBe("https://www.amazon.de/dp/B09LR81NNL");
    // Every other storefront is asked exactly as before.
    for (const other of amazonAdapters.slice(0, 4)) {
      expect(other.httpPolicy).not.toHaveProperty("query");
    }
  });

  it("is a Review when the page is delivered outside Germany, never an unavailable product", () => {
    const url = "https://www.amazon.de/dp/B09LR81NNL";
    for (const line of ["Deliver to United States", "Deliver to Latvia"]) {
      expect(() =>
        parseAmazonProduct({ url, html: html("B09LR81NNL", line), capturedAt }, AMAZON_DE),
      ).toThrow(expect.objectContaining({ code: "AMAZON.DELIVERY_ABROAD" }));
    }
  });
});

describe("amazon.de brand search (KAN-243, 2026-11-11)", () => {
  const reader = amazonSiteBrandScan(AMAZON_DE);
  // Page 1 of the Doctor's Best scan as amazon.de printed it in English: 62 results, page 2 linked under /-/en/s.
  const next =
    "/-/en/s?k=Doctor%27s+Best&amp;i=drugstore&amp;rh=n%3A64374031%2Cp_123%3A576086&amp;s=exact-aware-popularity-rank&amp;page=2&amp;language=en_GB&amp;xpid=trRbuf9g8en6f&amp;qid=1794399292&amp;ref=sr_pg_1";
  const page = `<html><body>
    <div id="p_123/576086"><input type="checkbox" checked></div>
    <div data-component-type="s-result-info-bar">1-24 of 62 results for "Doctor's Best"</div>
    <div class="s-main-slot"><div data-component-type="s-search-result" data-asin="B09LR81NNL"><a href="/-/en/x/dp/B09LR81NNL"><h2>Doctor's Best, PepZinGl</h2></a></div></div>
    <span class="s-pagination-item s-pagination-selected">1</span>
    <a href="${next}" role="button" aria-label="Go to next page, page 2" class="s-pagination-item s-pagination-next s-pagination-button">Next</a>
  </body></html>`;

  it("searches Vitamins, Minerals & Supplements in the drugstore department, in English, and follows the next page", () => {
    const source = amazonBrandSearch("Doctor's Best", "576086", AMAZON_DE);
    expect(source).toBe(
      "https://www.amazon.de/s?k=Doctor%27s+Best&i=drugstore&rh=n%3A64374031%2Cp_123%3A576086&s=exact-aware-popularity-rank&language=en_GB",
    );
    expect(reader.pageUrl(source, 2)).toBe(`${source}&page=2`);
    expect(
      new URL(amazonBrandLookupUrl("Doctor's Best", AMAZON_DE)).searchParams.get("language"),
    ).toBe("en_GB");
    expect(reader.parsePage({ body: page, url: reader.pageUrl(source, 1), page: 1 })).toMatchObject(
      { nextPage: 2 },
    );
  });

  it("reads a /-/en/s address as the same search, and leaves amazon.com's searches without a language", () => {
    expect(
      amazonScanSourceUrl(
        "https://www.amazon.de/-/en/s?k=Doctor%27s+Best&i=drugstore&rh=n%3A64374031%2Cp_123%3A576086",
        AMAZON_DE,
      ),
    ).toBe(amazonBrandSearch("Doctor's Best", "576086", AMAZON_DE));
    expect(amazonBrandSearch("Doctor's Best", "576086", AMAZON_US)).not.toContain("language");
  });
});
