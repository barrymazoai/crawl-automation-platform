import { amazonLabelFormats, labelLanguageOf } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { amazonAdapters } from "./adapter.js";
import { amazonProductAddress } from "./address.js";
import { amazonSiteBrandScan } from "./brand-scan.js";
import { amazonBrandSearch, amazonScanSourceUrl } from "./brand-scan-address.js";
import { amazonCommerce } from "./commerce.js";
import { amazonDocument, productRoot } from "./dom.js";
import { parseAmazonDate } from "./listing-date.js";
import { parseAmazonProduct } from "./product.js";
import { amazonSalesRank } from "./sales-rank.js";
import { AMAZON_DE, AMAZON_ES } from "./site.js";

// KAN-243: markup copied from the amazon.es page captured 2026-11-13 03:3x UTC for Doctor's Best High Absorption
// Magnesium B09BVX2XS7 (?language=en_GB). The archived pages stay out of git (R2 research/kan243-geo/scraperapi/es/).
const PRICE_TO_PAY = `<div id="corePriceDisplay_desktop_feature_div"><div class="a-section apex-core-price-identifier">
  <span class="a-price aok-align-center reinventPricePriceToPayMargin priceToPay apex-pricetopay-value" data-a-size="xl" data-a-color="base"><span class="a-offscreen"> </span><span aria-hidden="true"><span class="a-price-symbol">€</span><span class="a-price-whole">30<span class="a-price-decimal">.</span></span><span class="a-price-fraction">41</span></span></span>
</div></div>`;
const location = (line: string) =>
  `<a id="nav-global-location-popover-link"><span id="glow-ingress-line1">${line}</span>
  <span id="glow-ingress-line2">Update location</span></a>`;
const TITLE = `<span id="productTitle">Doctor's Best, High Absorption Magnesium, 100% Chelated with Albion Minerals, 120 Tablets</span>`;
const DETAILS = `<table id="productDetails_detailBullets_sections1"><tr> <th class="a-color-secondary a-size-base prodDetSectionEntry"> Best Sellers Rank </th> <td> <span> <ul class="a-unordered-list a-nostyle a-vertical"> <li><span class="a-list-item"><span>4,109 in Health & Household (<a href='/-/en/gp/bestsellers/hpc/ref=pd_zg_ts_hpc'>See Top 100 in Health & Household</a>)</span></span></li> <li><span class="a-list-item"><span>1,533 in <a href='/-/en/gp/bestsellers/hpc/4347039031/ref=pd_zg_hrsr_hpc'>Vitamins, Minerals & Supplements</a></span></span></li> </ul> </span> </td> </tr></table>`;

function html(asin: string, line: string | null) {
  return `<html><body>${line === null ? "" : location(line)}<div id="ppd"><input id="ASIN" value="${asin}">${TITLE}${PRICE_TO_PAY}</div><div id="prodDetails">${DETAILS}</div></body></html>`;
}

const capturedAt = "2026-11-13T03:30:00.000Z";

describe("amazon.es storefront (KAN-243, 2026-11-13)", () => {
  it("reads the price in euros and the delivery postcode", () => {
    const root = productRoot(amazonDocument(html("B09BVX2XS7", "Delivering to Madrid 28071")));
    const commerce = amazonCommerce(root, "B09BVX2XS7", AMAZON_ES);
    expect(commerce).toMatchObject({ price: "30.41", currency: "EUR", priceStatus: "observed" });
    for (const [line, code] of [
      ["Delivering to Madrid 28071", "28071"],
      ["Delivering to Parets De... 08150", "08150"],
      ["Delivering to Illescas 45200", "45200"],
    ] as const) {
      const at = productRoot(amazonDocument(html("B09BVX2XS7", line)));
      expect(
        amazonCommerce(at, "B09BVX2XS7", AMAZON_ES).purchaseConditions?.delivery.postalCode,
      ).toBe(code);
    }
  });

  it("reads the Best Sellers Rank printed without a #", () => {
    expect(
      amazonSalesRank(amazonDocument(html("B09BVX2XS7", "Delivering to Madrid 28071"))),
    ).toMatchObject({ rank: 4109, category: "Health & Household" });
  });

  it("reads Date First Available day first, the month abbreviated or written out", () => {
    for (const [raw, date] of [
      ["2 Dec. 2021", "2021-12-02"],
      ["9 Jun. 2023", "2023-06-09"],
      ["8 Feb. 2022", "2022-02-08"],
      ["13 July 2021", "2021-07-13"],
      ["9 Aug. 2023", "2023-08-09"],
    ] as const) {
      expect(parseAmazonDate(raw, AMAZON_ES)).toBe(date);
    }
    // "Sept." is no date-fns abbreviation: the optional date stays unknown, never guessed.
    expect(parseAmazonDate("9 Sept. 2016", AMAZON_ES)).toBeNull();
  });

  it("keeps the storefront's addresses to its own host, the English /-/en/ path included", () => {
    for (const raw of [
      "https://www.amazon.es/-/en/Doctors-Best-Absorption-Magnesium/dp/b09bvx2xs7",
      "https://www.amazon.es/dp/B09BVX2XS7?language=en_GB",
    ]) {
      expect(amazonProductAddress(raw, AMAZON_ES)).toEqual({
        url: "https://www.amazon.es/dp/B09BVX2XS7",
        listingId: "B09BVX2XS7",
        variantId: null,
      });
    }
    expect(() => amazonProductAddress("https://www.amazon.de/dp/B09BVX2XS7", AMAZON_ES)).toThrow();
    expect(() => amazonProductAddress("https://www.amazon.es/dp/B09BVX2XS7", AMAZON_DE)).toThrow();
  });

  it("is its own channel, asked in English, with its own formula family and Spanish labels", () => {
    const adapter = amazonAdapters[5];
    expect(adapter).toMatchObject({
      id: "amazon-es",
      formulaFamily: "amazon-es-asin",
      httpPolicy: { origins: ["https://www.amazon.es"], query: { language: "en_GB" } },
      planning: {
        channel: "amazon-es",
        parserVersion: "amazon-es-rendered/1",
        projectionModule: "amazon-es.http-projection",
      },
    });
    expect(adapter?.productUrl?.("b09bvx2xs7")).toBe("https://www.amazon.es/dp/B09BVX2XS7");
    expect(amazonLabelFormats("amazon-es")).toEqual([
      "us-facts/1",
      "in-nutritional-information/3",
      "es-food-supplement/1",
    ]);
    expect(labelLanguageOf("amazon-es")).toBe("es");
    expect(labelLanguageOf("amazon-de")).toBe("de");
  });

  it("is a Review when the page is delivered outside Spain, never an unavailable product", () => {
    const url = "https://www.amazon.es/dp/B09BVX2XS7";
    // One of 23 amazon.es pages on 2026-11-13 said "Deliver to United Kingdom".
    for (const line of ["Deliver to United Kingdom", "Deliver to Germany"]) {
      expect(() =>
        parseAmazonProduct({ url, html: html("B09BVX2XS7", line), capturedAt }, AMAZON_ES),
      ).toThrow(expect.objectContaining({ code: "AMAZON.DELIVERY_ABROAD" }));
    }
  });
});

describe("amazon.es brand search (KAN-243, 2026-11-13)", () => {
  const reader = amazonSiteBrandScan(AMAZON_ES);
  // Page 1 of the Doctor's Best search as amazon.es printed it in English: 62 results, page 2 linked under /-/en/s.
  const next =
    "/-/en/s?k=Doctor%27s+Best&amp;i=hpc&amp;rh=n%3A4347039031%2Cp_123%3A576086&amp;s=exact-aware-popularity-rank&amp;page=2&amp;language=en_GB&amp;xpid=Nmnn9vWwjM10k&amp;qid=1794540443&amp;ref=sr_pg_2";
  const page = `<html><body>
    <div id="p_123/576086"><input type="checkbox" checked></div>
    <div data-component-type="s-result-info-bar">1-24 of 62 results for "Doctor's Best"</div>
    <div class="s-main-slot"><div data-component-type="s-search-result" data-asin="B09BVX2XS7"><a href="/-/en/x/dp/B09BVX2XS7"><h2>Doctor's Best, High Absorption Magnesium</h2></a></div></div>
    <span class="s-pagination-item s-pagination-selected">1</span>
    <a href="${next}" role="button" aria-label="Go to next page, page 2" class="s-pagination-item s-pagination-next s-pagination-button">Next</a>
  </body></html>`;

  it("searches Vitamins, Minerals & Supplements in the hpc department, in English, and follows the next page", () => {
    const source = amazonBrandSearch("Doctor's Best", "576086", AMAZON_ES);
    expect(source).toBe(
      "https://www.amazon.es/s?k=Doctor%27s+Best&i=hpc&rh=n%3A4347039031%2Cp_123%3A576086&s=exact-aware-popularity-rank&language=en_GB",
    );
    expect(reader.parsePage({ body: page, url: reader.pageUrl(source, 1), page: 1 })).toMatchObject(
      { nextPage: 2 },
    );
    expect(
      amazonScanSourceUrl(
        "https://www.amazon.es/-/en/s?k=Doctor%27s+Best&i=hpc&rh=n%3A4347039031%2Cp_123%3A576086",
        AMAZON_ES,
      ),
    ).toBe(source);
  });
});
