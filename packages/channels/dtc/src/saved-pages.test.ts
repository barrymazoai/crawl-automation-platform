import { describe, expect, it } from "vitest";
import { readShopifyData, shopifyRecords } from "@crawl-automation/channels-core";
import { dtcIdentityKey } from "./identity.js";
import { createDtcAdapter } from "./adapter.js";
import { dtcSitePolicy } from "./site-policy.js";
import { savedDtcData, MISSING_DTC_DATA } from "./saved-data.js";

const capturedAt = "2026-09-10T00:00:00.000Z";
const evidence = "real-crawl-results/four-brands-20260910/evidence";
const raw = "real-crawl-results/seven-brands-20260903/raw";
const shopify = savedDtcData(`${evidence}/innerbody-sleep-support-raw.json`);
const bella = savedDtcData(`${evidence}/bellagrace-products-raw.json`);
const maurten = savedDtcData(`${raw}/maurten-gel-100-box-us.html`);
const woo = savedDtcData("dtc/woocommerce-product.html", "exports/dtc/hmwmethod-product.html");
const shopifyHtml = savedDtcData(
  "dtc/shopify-product.html",
  "exports/dtc/shopbellagrace-product.html",
);

describe.skipIf(!shopify)(
  `real Innerbody Shopify product JSON${shopify ? "" : `: ${MISSING_DTC_DATA}`}`,
  () => {
    it("reads the saved integer-cent prices, product ID, variants and label image candidates", () => {
      const record = shopifyRecords(JSON.parse(shopify?.text ?? "null"))[0];
      expect(record).toBeDefined();
      const product = readShopifyData(
        record ?? {},
        "https://shop.innerbody.com/products/sleep-support",
      );
      expect(product.title).toBe("Sleep Support");
      expect(product.productId).toBe("7540959379542");
      expect(product.variants[0]).toMatchObject({
        id: "42250782867542",
        price: "390.00",
        availability: "in_stock",
      });
      expect(product.images.length).toBeGreaterThan(1);
      expect(
        product.variants.every((variant) => variant.url.includes(`variant=${variant.id}`)),
      ).toBe(true);
    });
  },
);

describe.skipIf(!bella)(
  `real Bella Grace Shopify catalog JSON${bella ? "" : `: ${MISSING_DTC_DATA}`}`,
  () => {
    it("reads all saved records and preserves decimal prices without dividing by 100", () => {
      const records = shopifyRecords(JSON.parse(bella?.text ?? "null"));
      expect(records.length).toBeGreaterThan(1);
      const product = readShopifyData(
        records[0] ?? {},
        "https://shopbellagrace.com/products/restorative-sleep-gummies",
      );
      expect(product.title).toBe("RESTorative Sleep Gummies");
      expect(product.productId).toBe("8750333198563");
      expect(product.variants[0]).toMatchObject({ id: "45908104151267", price: "42.00" });
      expect(product.images.length).toBeGreaterThan(1);
    });
  },
);

describe.skipIf(!maurten)(
  `real Maurten JSON-LD HTML${maurten ? "" : `: ${MISSING_DTC_DATA}`}`,
  () => {
    const site = dtcSitePolicy({
      siteKey: "maurten.com",
      platform: "jsonld",
      catalogUrl: "https://www.maurten.com/shop",
      origins: ["https://www.maurten.com"],
      imageOrigins: ["https://www.maurten.com", "https://maurten.imgix.net"],
      productSelector: "main.page--product-page",
    });
    const adapter = createDtcAdapter([site]);
    const page = {
      url: "https://www.maurten.com/products/gel-100-box-us",
      html: maurten?.text ?? "",
      capturedAt,
    };
    it("reads graph Product, site brand, price, availability and page identity", () => {
      const parsed = adapter.parseProduct(page);
      expect(parsed.evidence).toMatchObject({
        title: "Gel 100",
        brandRaw: "maurten.com",
        listingId: dtcIdentityKey("maurten.com", "22002"),
      });
      expect(parsed.commerce).toMatchObject({
        price: "45.00",
        currency: "USD",
        availability: "InStock",
      });
      expect(adapter.pageIdentity?.(page)).toEqual({
        listingId: dtcIdentityKey("maurten.com", "/products/gel-100-box-us"),
        variantId: null,
      });
      expect(parsed.facts.complete).toBe(false);
      expect(parsed.evidence.imageCandidates.length).toBeGreaterThan(0);
      expect(
        parsed.evidence.imageCandidates.some((image) => image.url.includes("GEL100_US.jpg")),
      ).toBe(true);
    });
    it("reads back its retained projection with the same facts judgement", () => {
      const parsed = adapter.parseProduct(page);
      const plan = adapter.planning;
      expect(plan?.read(plan.projection(parsed.rendered), page.url, parsed.identity)).toEqual({
        evidence: parsed.evidence,
        facts: parsed.facts,
      });
    });
  },
);

describe.skipIf(!woo)(`real WooCommerce HTML${woo ? "" : `: ${MISSING_DTC_DATA}`}`, () => {
  it("reads the real product selected by its canonical URL", () => {
    const site = dtcSitePolicy({
      siteKey: "hmwmethod.com",
      platform: "woocommerce",
      catalogUrl: "https://hmwmethod.com/shop",
    });
    const adapter = createDtcAdapter([site]);
    const parsed = adapter.parseProduct({
      url: "https://hmwmethod.com/product/saved",
      html: woo?.text ?? "",
      capturedAt,
    });
    expect(parsed.evidence.title).not.toBe("");
    expect(parsed.evidence.brandRaw).toBe("hmwmethod.com");
    expect(parsed.rendered.platform).toBe("woocommerce");
  });
});

describe.skipIf(!shopifyHtml)(
  `real Shopify HTML${shopifyHtml ? "" : `: ${MISSING_DTC_DATA}`}`,
  () => {
    it("reads embedded data and rendered selection together", () => {
      const site = dtcSitePolicy({
        siteKey: "shopbellagrace.com",
        platform: "shopify",
        catalogUrl: "https://shopbellagrace.com/collections/wellness",
      });
      const parsed = createDtcAdapter([site]).parseProduct({
        url: "https://shopbellagrace.com/products/saved",
        html: shopifyHtml?.text ?? "",
        capturedAt,
      });
      expect(parsed.evidence.brandRaw).toBe(site.siteKey);
      expect(parsed.evidence.title).not.toBe("");
      expect(parsed.rendered.platform).toBe("shopify");
    });
  },
);
