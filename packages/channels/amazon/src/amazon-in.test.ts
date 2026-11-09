import { describe, expect, it } from "vitest";
import { amazonAdapter, amazonInAdapter } from "./adapter.js";
import { amazonProductAddress } from "./address.js";
import { amazonBrandScan } from "./brand-scan.js";
import { amazonScanPageUrl, amazonScanSourceUrl } from "./brand-scan-address.js";
import { amazonSiteBrandScan } from "./brand-scan.js";
import { amazonCommerce } from "./commerce.js";
import { amazonDocument, productRoot } from "./dom.js";
import { parseAmazonDate } from "./listing-date.js";
import { AMAZON_IN, AMAZON_US } from "./site.js";

// KAN-243: markup copied from real amazon.in pages captured 2026-11-04 (NOW Glucosamine B0019LWV92, Kapiva Shilajit
// B0BL3TN1QC); the saved pages themselves stay out of git (R2 research/kan243-india/scraperapi/).
const PRICE_TO_PAY = (whole: string) => `<div id="corePriceDisplay_desktop_feature_div">
  <span id="apex-pricetopay-accessibility-label" class="aok-offscreen"> ₹${whole}.00 with 57 percent savings </span>
  <span class="a-price aok-align-center reinventPricePriceToPayMargin priceToPay apex-pricetopay-value"><span class="a-offscreen"> </span><span aria-hidden="true"><span class="a-price-symbol">₹</span><span class="a-price-whole">${whole}</span></span></span>
  <span class="a-size-small aok-offscreen"> ₹5,495 per 100 g </span>
  <span class="basisPrice">M.R.P.: <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">₹4,999</span></span></span>
</div>`;
const LOCATION = `<a id="nav-global-location-popover-link"><span id="glow-ingress-line1">Delivering to Mumbai 400017</span>
  <span id="glow-ingress-line2">Update location</span></a>`;
const DATE = `<div id="detailBullets_feature_div"><ul><li><span><span class="a-text-bold">Date First Available
  &rlm;
  :
  &lrm;
  </span><span>7 August 2012</span></span></li></ul></div>`;

function page(body: string) {
  const document = amazonDocument(
    `<html><body>${LOCATION}<div id="ppd"><input id="ASIN" value="B0019LWV92">${body}</div>${DATE}</body></html>`,
  );
  return productRoot(document);
}

describe("amazon.in storefront", () => {
  it("reads the price to pay in rupees, never the per-100 g unit price, and the MRP as list price", () => {
    const commerce = amazonCommerce(page(PRICE_TO_PAY("2,129")), "B0019LWV92", AMAZON_IN);
    expect(commerce).toMatchObject({
      price: "2129.00",
      currency: "INR",
      listPrice: "4999",
      priceStatus: "observed",
    });
    expect(commerce.dateFirstAvailable?.date).toBe("2012-08-07");
    expect(commerce.purchaseConditions?.delivery.postalCode).toBe("400017");
  });

  it("leaves amazon.com reading exactly as before: a rupee price is not a US price", () => {
    const commerce = amazonCommerce(page(PRICE_TO_PAY("2,129")), "B0019LWV92", AMAZON_US);
    expect(commerce).toMatchObject({ price: null, currency: null, listPrice: null });
    expect(commerce.dateFirstAvailable?.date).toBeNull();
    expect(parseAmazonDate("August 7, 2012")).toBe("2012-08-07");
    expect(parseAmazonDate("7 August 2012", AMAZON_IN)).toBe("2012-08-07");
    expect(parseAmazonDate("August 7, 2012", AMAZON_IN)).toBeNull();
  });

  it("keeps each storefront's addresses to its own host", () => {
    expect(
      amazonProductAddress("https://www.amazon.in/Kapiva-Shilajit/dp/b0bl3tn1qc?th=1", AMAZON_IN),
    ).toEqual({
      url: "https://www.amazon.in/dp/B0BL3TN1QC",
      listingId: "B0BL3TN1QC",
      variantId: null,
    });
    expect(() => amazonProductAddress("https://www.amazon.in/dp/B0BL3TN1QC")).toThrow();
    expect(() => amazonProductAddress("https://www.amazon.com/dp/B0BL3TN1QC", AMAZON_IN)).toThrow();
    expect(amazonInAdapter.productUrl?.("b0bl3tn1qc")).toBe("https://www.amazon.in/dp/B0BL3TN1QC");
  });

  it("is its own channel with its own formula family, parser version and HTTP origin", () => {
    expect(amazonInAdapter).toMatchObject({
      id: "amazon-in",
      formulaFamily: "amazon-in-asin",
      httpPolicy: { origins: ["https://www.amazon.in"] },
      planning: {
        channel: "amazon-in",
        parserVersion: "amazon-in-rendered/1",
        projectionModule: "amazon-in.http-projection",
      },
    });
    expect(amazonAdapter).toMatchObject({
      id: "amazon",
      formulaFamily: "amazon-asin",
      httpPolicy: { origins: ["https://www.amazon.com"] },
      planning: {
        channel: "amazon",
        parserVersion: "amazon-rendered/1",
        projectionModule: "amazon.http-projection",
      },
    });
    expect(amazonAdapter.brandScan).toBe(amazonBrandScan);
    expect(amazonInAdapter.planning?.labelFormats).toEqual([
      "us-facts/1",
      "in-nutritional-information/2",
      "in-composition/2",
    ]);
    expect(amazonAdapter.planning).not.toHaveProperty("labelFormats");
  });

  it("scans Brand-filter searches on amazon.in over HTTP; a Store page is read in a browser on amazon.com only", () => {
    const search = "https://www.amazon.in/s?k=Kapiva&rh=n%3A1374489031%2Cp_123%3A341461";
    const page1 = new URL(amazonInAdapter.brandScan?.pageUrl(search, 1) ?? "");
    expect(page1.origin).toBe("https://www.amazon.in");
    expect(page1.searchParams.get("rh")).toBe("n:1374489031,p_123:341461");
    expect(() =>
      amazonInAdapter.brandScan?.sourceUrl("https://www.amazon.com/s?k=Kapiva&rh=p_123%3A341461"),
    ).toThrow();
    expect(amazonInAdapter.scanCapture?.("https://www.amazon.in/stores/page/ABC")).toBe("http");
    expect(amazonAdapter.scanCapture?.("https://www.amazon.com/stores/page/ABC")).toBe("browser");
  });
});

describe("amazon.in brand scan order (owner 2026-11-08)", () => {
  // Himalaya: newest first filled the seven pages with reseller relistings that print no label.
  const himalaya = "https://www.amazon.in/s?k=Himalaya&i=hpc&rh=n%3A1374489031%2Cp_123%3A94291";

  it("reads best sellers first on amazon.in, newest first on amazon.com", () => {
    expect(new URL(amazonScanSourceUrl(himalaya, AMAZON_IN)).searchParams.get("s")).toBe(
      "exact-aware-popularity-rank",
    );
    expect(new URL(amazonScanPageUrl(himalaya, 2, AMAZON_IN)).search).toBe(
      "?k=Himalaya&i=hpc&rh=n%3A1374489031%2Cp_123%3A94291&s=exact-aware-popularity-rank&page=2",
    );
    const us = "https://www.amazon.com/s?k=Himalaya&i=hpc&rh=n%3A3760901%2Cp_123%3A94291";
    expect(new URL(amazonScanSourceUrl(us, AMAZON_US)).searchParams.get("s")).toBe(
      "date-desc-rank",
    );
  });
});

describe("amazon.in brand scan size (owner 2026-11-08, demo week)", () => {
  const source = "https://www.amazon.in/s?k=Himalaya&i=hpc&rh=n%3A1374489031%2Cp_123%3A94291";
  const reader = amazonSiteBrandScan(AMAZON_IN);
  // A best-seller search page as amazon.in prints it: result cards, the brand facet ticked, a next-page link.
  const page = (cards = 24, at = 1) => {
    const card = (index: number) => {
      const asin = `B0${String(index).padStart(8, "0")}`;
      return `<div data-component-type="s-search-result" data-asin="${asin}"><a href="/x/dp/${asin}"><h2>Himalaya product ${index}</h2></a></div>`;
    };
    const first = (at - 1) * cards;
    const next = amazonScanPageUrl(source, at + 1, AMAZON_IN).replace("https://www.amazon.in", "");
    return `<html><body>
      <div id="p_123/94291"><input type="checkbox" checked></div>
      <div data-component-type="s-result-info-bar">${first + 1}-${first + cards} of 223 results for "Himalaya"</div>
      <div class="s-main-slot">${Array.from({ length: cards }, (_, index) => card(first + index + 1)).join("")}</div>
      <span class="s-pagination-selected">${at}</span><a class="s-pagination-next" href="${next}">Next</a>
    </body></html>`;
  };

  const asins = (count: number, from = 1) =>
    Array.from({ length: count }, (_, index) => `B0${String(from + index).padStart(8, "0")}`);

  it("reads two pages of a brand's best sellers, 48 products; the scan is capped, never full", () => {
    expect(reader.maxPages).toBe(2);
    const first = reader.parsePage({ body: page(), url: reader.pageUrl(source, 1), page: 1 });
    expect(first.products.map((product) => product.listingId)).toEqual(asins(24));
    expect(first).toMatchObject({ nextPage: 2, capped: false });
    expect(first.products[0]?.url).toBe("https://www.amazon.in/dp/B000000001");
    const second = reader.parsePage({ body: page(24, 2), url: reader.pageUrl(source, 2), page: 2 });
    expect(second.products.map((product) => product.listingId)).toEqual(asins(24, 25));
    expect(second).toMatchObject({ nextPage: null, capped: true });
  });

  it("keeps the first fifty of a longer page", () => {
    const listed = reader.parsePage({ body: page(60), url: reader.pageUrl(source, 1), page: 1 });
    expect(listed.products.map((product) => product.listingId)).toEqual(asins(50));
    expect(listed).toMatchObject({ nextPage: null, capped: true });
  });

  it("leaves the amazon.com scan at seven pages and every product", () => {
    expect(amazonBrandScan.maxPages).toBe(7);
    expect(AMAZON_US).toMatchObject({ scanPages: 7, scanProducts: null });
  });
});
