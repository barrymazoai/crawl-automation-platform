import { expect, it } from "vitest";
import { BrowserSettingsSchema } from "./browser-settings.js";

const browser = {
  ego: { cliPath: "/tmp/unused-ego", taskSpaceId: 1 },
  wholefoods: { storeId: "10259", label: "The Alameda", postalCode: "95126" },
};

it("defaults and validates Whole Foods canary and press pacing at worker startup", () => {
  expect(BrowserSettingsSchema.parse(browser).wholefoodsScan).toEqual({
    canaryUrl: "https://www.wholefoodsmarket.com/grocery/search?k=365+by+Whole+Foods+Market",
    pressDelayMs: { min: 4000, max: 8000 },
  });
  for (const wholefoodsScan of [
    { canaryUrl: "https://example.com/grocery/search?k=365" },
    { pressDelayMs: { min: 8000, max: 4000 } },
    { pressDelayMs: { min: -1, max: 4000 } },
  ]) {
    expect(BrowserSettingsSchema.safeParse({ ...browser, wholefoodsScan }).success).toBe(false);
  }
});

it("keeps existing browser config valid with an empty DTC site list", () => {
  expect(BrowserSettingsSchema.parse(browser).dtc.sites).toEqual([]);
});

it("parses the five-brand Shopify example without enabling it by default", () => {
  const brands = [
    ["Metagenics", "metagenics"],
    ["Pure Encapsulations", "pure-encapsulations"],
    ["Life Extension", "life-extension"],
    ["Allergy Research", "allergy-research"],
    ["Thorne", "thorne"],
  ].map(([brand, handle]) => ({
    brand,
    catalogUrl: `https://nutriessential.com/collections/${handle}`,
  }));
  const dtc = {
    sites: [{ siteKey: "nutriessential.com", kind: "multi-brand", platform: "shopify", brands }],
  };
  expect(BrowserSettingsSchema.parse({ ...browser, dtc }).dtc).toEqual(dtc);
  expect(BrowserSettingsSchema.parse(browser).dtc.sites).toEqual([]);
  expect(
    BrowserSettingsSchema.safeParse({
      ...browser,
      dtc: {
        sites: [{ ...dtc.sites[0], catalogUrl: "https://nutriessential.com/collections/all" }],
      },
    }).success,
  ).toBe(false);
});

it("reads browser.dtc.sites without inferring any site or platform", () => {
  const dtc = {
    sites: [
      {
        siteKey: "shop.example",
        platform: "woocommerce",
        catalogUrl: "https://shop.example/shop",
      },
    ],
  };
  expect(BrowserSettingsSchema.parse({ ...browser, dtc }).dtc).toEqual(dtc);
  expect(
    BrowserSettingsSchema.safeParse({
      ...browser,
      dtc: {
        sites: [{ ...dtc.sites[0], platform: "unverified" }],
      },
    }).success,
  ).toBe(false);
});

it("validates Costco's verify-only warehouse, canary and pacing at startup", () => {
  expect(BrowserSettingsSchema.parse(browser)).toMatchObject({
    costco: { storeId: "669", label: "Southlake", postalCode: "76051" },
    costcoScan: { pressDelayMs: { min: 4000, max: 8000 } },
  });
  expect(
    BrowserSettingsSchema.safeParse({
      ...browser,
      costco: { storeId: "1", label: "Seattle", postalCode: "98101" },
    }).success,
  ).toBe(false);
  expect(
    BrowserSettingsSchema.safeParse({
      ...browser,
      costcoScan: { canaryUrl: "https://www.costco.com/p/-/123" },
    }).success,
  ).toBe(false);
});
