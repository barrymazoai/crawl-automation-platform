import { describe, expect, it } from "vitest";
import { amazonAdapters } from "./adapter.js";
import { amazonProductAddress } from "./address.js";
import { amazonBrandLookupUrl } from "./brand-lookup.js";
import { amazonSiteBrandScan } from "./brand-scan.js";
import { amazonBrandSearch } from "./brand-scan-address.js";
import { amazonCommerce } from "./commerce.js";
import { amazonDocument, productRoot } from "./dom.js";
import { parseAmazonDate } from "./listing-date.js";
import { parseAmazonProduct } from "./product.js";
import { AMAZON_CA, AMAZON_UK } from "./site.js";

// KAN-243: markup copied from real amazon.ca pages captured 2026-11-11 (Jamieson Vitamin D3 B01NARPPT8, Webber
// Naturals B00B4JDYHC); the saved pages themselves stay out of git (R2 research/kan243-geo/scraperapi/ca/).
const PRICE_TO_PAY = `<div id="corePriceDisplay_desktop_feature_div">
  <span id="apex-pricetopay-accessibility-label" class="aok-offscreen"> $11.81 with 41 percent savings </span>
  <span class="a-price aok-align-center reinventPricePriceToPayMargin priceToPay apex-pricetopay-value"><span class="a-offscreen"> </span><span aria-hidden="true"><span class="a-price-symbol">$</span><span class="a-price-whole">11<span class="a-price-decimal">.</span></span><span class="a-price-fraction">81</span></span></span>
  <span class="a-size-mini aok-offscreen apex-priceperunit-accessibility-label">$0.02 per count</span>
  <span class="apex-basisprice-feature"><span class="a-size-small aok-offscreen apex-basisprice-offscreen-label">List Price: $19.99</span><span aria-hidden="true" class="a-size-small a-color-secondary aok-align-center basisPrice"><span class="apex-basisprice-label">List Price:</span> <span class="a-price a-text-price apex-basisprice-value" data-a-strike="true"><span class="a-offscreen">$19.99</span><span aria-hidden="true">$19.99</span></span></span></span>
</div>`;
const location = (line: string) =>
  `<a id="nav-global-location-popover-link"><span id="glow-ingress-line1">${line}</span>
  <span id="glow-ingress-line2">Update location</span></a>`;
const TITLE = `<span id="productTitle">Jamieson Vitamin D3 1,000 IU Tablets</span>`;
const DETAILS = `<div id="detailBullets_feature_div"><ul>
  <li><span class="a-list-item"><span class="a-text-bold">Date First Available &rlm; : &lrm; </span> <span>Jan. 23 2013</span></span></li>
</ul></div>`;

function html(asin: string, line: string | null) {
  return `<html><body>${line === null ? "" : location(line)}<div id="ppd"><input id="ASIN" value="${asin}">${TITLE}${PRICE_TO_PAY}</div>${DETAILS}</body></html>`;
}

const capturedAt = "2026-11-11T01:00:00.000Z";

describe("amazon.ca storefront (KAN-243, 2026-11-11)", () => {
  it("reads the price to pay in Canadian dollars, the list price and the delivery postal code", () => {
    const root = productRoot(amazonDocument(html("B01NARPPT8", "Delivering to Montreal H3H")));
    const commerce = amazonCommerce(root, "B01NARPPT8", AMAZON_CA);
    expect(commerce).toMatchObject({
      price: "11.81",
      currency: "CAD",
      listPrice: "19.99",
      priceStatus: "observed",
    });
    expect(commerce.purchaseConditions?.delivery.postalCode).toBe("H3H");
    for (const [line, code] of [
      ["Delivering to Balzac T4B 2T3", "T4B 2T3"],
      ["Delivering to Fort Qu'a... S0G", "S0G"],
      ["Delivering to La Prairie J5R", "J5R"],
      ["Delivering to Toronto M5A", "M5A"],
      ["Delivering to Montreal h1a", "h1a"],
    ] as const) {
      const at = productRoot(amazonDocument(html("B01NARPPT8", line)));
      expect(
        amazonCommerce(at, "B01NARPPT8", AMAZON_CA).purchaseConditions?.delivery.postalCode,
      ).toBe(code);
    }
  });

  it("never reads a US$ price as Canadian dollars", () => {
    const usd = html("B01NARPPT8", "Delivering to Montreal H3H").replaceAll("$", "US$");
    const commerce = amazonCommerce(productRoot(amazonDocument(usd)), "B01NARPPT8", AMAZON_CA);
    expect(commerce.price ?? null).toBeNull();
  });

  it("reads Date First Available as amazon.ca prints it: a short month with a point, a long one in full", () => {
    expect(parseAmazonDate("Jan. 23 2013", AMAZON_CA)).toBe("2013-01-23");
    expect(parseAmazonDate("Oct. 26 2022", AMAZON_CA)).toBe("2022-10-26");
    expect(parseAmazonDate("June 3 2014", AMAZON_CA)).toBe("2014-06-03");
    expect(parseAmazonDate("May 7 2013", AMAZON_CA)).toBe("2013-05-07");
    expect(parseAmazonDate("2013-01-23", AMAZON_CA)).toBeNull();
    expect(
      parseAmazonProduct(
        {
          url: "https://www.amazon.ca/dp/B00B4JDYHC",
          html: html("B00B4JDYHC", "Delivering to Montreal H3H"),
          capturedAt,
        },
        AMAZON_CA,
      ).commerce?.dateFirstAvailable?.date,
    ).toBe("2013-01-23");
  });

  it("keeps the storefront's addresses to its own host", () => {
    expect(
      amazonProductAddress("https://www.amazon.ca/Jamieson/dp/b01narppt8?th=1", AMAZON_CA),
    ).toEqual({
      url: "https://www.amazon.ca/dp/B01NARPPT8",
      listingId: "B01NARPPT8",
      variantId: null,
    });
    expect(() => amazonProductAddress("https://www.amazon.com/dp/B01NARPPT8", AMAZON_CA)).toThrow();
    expect(() => amazonProductAddress("https://www.amazon.ca/dp/B01NARPPT8", AMAZON_UK)).toThrow();
  });

  it("is its own channel with its own formula family, parser version, HTTP origin and label formats", () => {
    expect(amazonAdapters.map((adapter) => adapter.id)).toEqual([
      "amazon",
      "amazon-in",
      "amazon-uk",
      "amazon-ca",
      "amazon-de",
      "amazon-es",
    ]);
    expect(amazonAdapters[3]).toMatchObject({
      id: "amazon-ca",
      formulaFamily: "amazon-ca-asin",
      httpPolicy: { origins: ["https://www.amazon.ca"] },
      planning: {
        channel: "amazon-ca",
        parserVersion: "amazon-ca-rendered/1",
        projectionModule: "amazon-ca.http-projection",
      },
    });
    expect(amazonAdapters[3]?.productUrl?.("b01narppt8")).toBe(
      "https://www.amazon.ca/dp/B01NARPPT8",
    );
  });

  it("is a Review when the page is delivered outside Canada, never an unavailable product", () => {
    const url = "https://www.amazon.ca/dp/B01NARPPT8";
    for (const line of ["Deliver to United States", "Deliver to South Africa"]) {
      expect(() =>
        parseAmazonProduct({ url, html: html("B01NARPPT8", line), capturedAt }, AMAZON_CA),
      ).toThrow(expect.objectContaining({ code: "AMAZON.DELIVERY_ABROAD" }));
    }
  });
});

describe("amazon.ca brand search (KAN-243, 2026-11-11)", () => {
  const reader = amazonSiteBrandScan(AMAZON_CA);
  // Page 1 of the Webber Naturals scan as amazon.ca printed it: 219 results, its next-page link in the `hpc` department.
  const next =
    "/s?k=Webber+Naturals&amp;i=hpc&amp;rh=n%3A6369748011%2Cp_123%3A336554&amp;s=exact-aware-popularity-rank&amp;page=2&amp;xpid=A-YfdnyodEM66&amp;qid=1794357377&amp;ref=sr_pg_1";
  const page = `<html><body>
    <div id="p_123/336554"><input type="checkbox" checked></div>
    <div data-component-type="s-result-info-bar">1-24 of 219 results for "Webber Naturals"</div>
    <div class="s-main-slot"><div data-component-type="s-search-result" data-asin="B00B4JDYHC"><a href="/x/dp/B00B4JDYHC"><h2>Webber Naturals Vitamin D3 1000 IU</h2></a></div></div>
    <span class="s-pagination-item s-pagination-selected">1</span>
    <a href="${next}" role="button" aria-label="Go to next page, page 2" class="s-pagination-item s-pagination-next s-pagination-button">Next</a>
  </body></html>`;

  it("searches Vitamins, Minerals & Supplements in the hpc department and follows the next page", () => {
    const source = amazonBrandSearch("Webber Naturals", "336554", AMAZON_CA);
    expect(source).toBe(
      "https://www.amazon.ca/s?k=Webber+Naturals&i=hpc&rh=n%3A6369748011%2Cp_123%3A336554&s=exact-aware-popularity-rank",
    );
    expect(new URL(amazonBrandLookupUrl("Webber Naturals", AMAZON_CA)).searchParams.get("i")).toBe(
      "hpc",
    );
    expect(reader.parsePage({ body: page, url: reader.pageUrl(source, 1), page: 1 })).toMatchObject(
      { nextPage: 2 },
    );
  });
});
