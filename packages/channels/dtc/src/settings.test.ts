import { describe, expect, it } from "vitest";
import { configuredDtcSites, DtcSettingsSchema } from "./settings.js";

const site = {
  siteKey: "shop.example",
  platform: "shopify",
  catalogUrl: "https://shop.example/collections/all",
};

describe("browser-verified DTC site settings", () => {
  it("defaults to no enabled sites", () => {
    expect(DtcSettingsSchema.parse({})).toEqual({ sites: [] });
    expect(configuredDtcSites()).toEqual([]);
  });

  it.each(["shopify", "woocommerce", "jsonld"])("accepts the observed %s platform", (platform) => {
    const settings = DtcSettingsSchema.parse({ sites: [{ ...site, platform }] });
    expect(configuredDtcSites(settings)[0]).toMatchObject({
      ...site,
      platform,
      origins: ["https://shop.example"],
    });
  });

  it.each([
    { ...site, platform: "unverified" },
    { ...site, platform: "unknown" },
    { ...site, catalogUrl: null },
    { ...site, catalogUrl: "invalid address" },
    { ...site, catalogUrl: "http://shop.example/collections/all" },
    { ...site, catalogUrl: "https://other.example/collections/all" },
    { ...site, catalogUrl: "https://user@shop.example/collections/all" },
    { ...site, catalogUrl: "https://shop.example:8443/collections/all" },
    { ...site, siteKey: "https://shop.example" },
  ])("refuses unverified or inconsistent settings: %j", (entry) => {
    expect(DtcSettingsSchema.safeParse({ sites: [entry] }).success).toBe(false);
  });

  it("refuses duplicate site keys", () => {
    expect(DtcSettingsSchema.safeParse({ sites: [site, site] }).success).toBe(false);
  });
});
