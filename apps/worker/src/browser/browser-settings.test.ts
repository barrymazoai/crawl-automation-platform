import { expect, it } from "vitest";
import { BrowserSettingsSchema } from "./browser-settings.js";

const browser = {
  ego: { cliPath: "/tmp/unused-ego", taskSpaceId: 1 },
  wholefoods: { storeId: "10259", label: "The Alameda", postalCode: "95126" },
};

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
