import { describe, expect, it } from "vitest";
import { configuredDtcSites, DtcSettingsSchema } from "./settings.js";
import { dtcBrandSources } from "./brand-source.js";
import { dtcBrandSourceUrl } from "./address.js";

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

const retailer = {
  siteKey: "nutriessential.com",
  kind: "multi-brand",
  platform: "shopify",
  brands: [
    { brand: "Metagenics", catalogUrl: "https://nutriessential.com/collections/metagenics" },
    {
      brand: "Pure Encapsulations",
      catalogUrl: "https://nutriessential.com/collections/pure-encapsulations",
    },
    {
      brand: "Life Extension",
      catalogUrl: "https://nutriessential.com/collections/life-extension",
    },
    {
      brand: "Allergy Research",
      catalogUrl: "https://nutriessential.com/collections/allergy-research",
    },
    { brand: "Thorne", catalogUrl: "https://nutriessential.com/collections/thorne" },
  ],
};

describe("one brand on one site per DTC source", () => {
  it("expands the example retailer into five independent sources and no whole-site source", () => {
    const sites = configuredDtcSites(DtcSettingsSchema.parse({ sites: [retailer] }));
    const sources = dtcBrandSources(sites);
    expect(sources.map(({ brand, catalogUrl }) => ({ brand, catalogUrl }))).toEqual(
      retailer.brands,
    );
    expect(new Set(sources.map((entry) => entry.sourceId)).size).toBe(5);
    expect(sources.every((entry) => entry.siteKey === retailer.siteKey)).toBe(true);
    for (const source of sources) {
      expect(dtcBrandSourceUrl(source.catalogUrl, sites)).toBe(source.catalogUrl);
    }
    expect(() => dtcBrandSourceUrl("https://nutriessential.com/collections/all", sites)).toThrow();
  });

  it.each([undefined, "single-brand"])("preserves single-brand sources with kind %s", (kind) => {
    const sites = configuredDtcSites(DtcSettingsSchema.parse({ sites: [{ ...site, kind }] }));
    expect(sites[0]?.kind).toBe("single-brand");
    expect(dtcBrandSources(sites)).toEqual([
      expect.objectContaining({
        siteKey: site.siteKey,
        brand: site.siteKey,
        catalogUrl: site.catalogUrl,
      }),
    ]);
  });

  it.each([
    { ...retailer, kind: "retailer" },
    { ...retailer, kind: "single-brand" },
    { ...retailer, catalogUrl: "https://nutriessential.com/collections/all" },
    { ...retailer, brands: [] },
    { ...retailer, brands: [{ brand: " ", catalogUrl: retailer.brands[0]?.catalogUrl }] },
    {
      ...retailer,
      brands: [{ brand: "Thorne", catalogUrl: "https://elsewhere.example/collections/thorne" }],
    },
    {
      ...retailer,
      brands: [{ brand: "Thorne", catalogUrl: "http://nutriessential.com/collections/thorne" }],
    },
    {
      ...retailer,
      brands: [
        { brand: "Thorne", catalogUrl: "https://u:p@nutriessential.com/collections/thorne" },
      ],
    },
    {
      ...retailer,
      brands: [
        { brand: "Thorne", catalogUrl: "https://nutriessential.com/collections/thorne#more" },
      ],
    },
    { ...retailer, brands: [retailer.brands[0], retailer.brands[0]] },
    { ...retailer, brands: [retailer.brands[0], { ...retailer.brands[1], brand: " metagenics " }] },
    { ...retailer, brands: [retailer.brands[0], { ...retailer.brands[0], brand: "Other" }] },
  ])("rejects ambiguous or unsafe multi-brand settings: %j", (entry) => {
    expect(DtcSettingsSchema.safeParse({ sites: [entry] }).success).toBe(false);
  });

  it("namespaces the same brand separately on different sites", () => {
    const other = {
      ...retailer,
      siteKey: "other.example",
      brands: [{ brand: "Thorne", catalogUrl: "https://other.example/collections/thorne" }],
    };
    const sources = dtcBrandSources(
      configuredDtcSites(DtcSettingsSchema.parse({ sites: [retailer, other] })),
    ).filter((entry) => entry.brand === "Thorne");
    expect(sources).toHaveLength(2);
    expect(sources[0]?.sourceId).not.toBe(sources[1]?.sourceId);
  });
});
