import { expect, it } from "vitest";
import { BrowserSettingsSchema } from "./browser-settings.js";

const browser = {
  ego: { cliPath: "/tmp/unused-ego", taskSpaceId: 1 },
  wholefoods: { storeId: "10259", label: "The Alameda", postalCode: "95126" },
};

it("keeps existing browser config valid with an empty DTC site list", () => {
  expect(BrowserSettingsSchema.parse(browser).dtc.sites).toEqual([]);
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
