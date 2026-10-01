import { readFileSync } from "node:fs";
import { costcoAdapter } from "@crawl-automation/channels-costco";
import {
  commerceMetrics,
  formulaFamilies,
  identifyListing,
  listingIdentityResolver,
} from "@crawl-automation/app";
import { amazonAdapter } from "@crawl-automation/channel-amazon";
import { swansonAdapter } from "@crawl-automation/channel-swanson";
import { ChannelRegistry, type ChannelAdapter } from "@crawl-automation/channels-core";
import { gncAdapter } from "@crawl-automation/channels-gnc";
import { wholeFoodsAdapter } from "@crawl-automation/channels-wholefoods";
import { expect, it, vi } from "vitest";

const wholefoods = wholeFoodsAdapter({ storeId: "10259", label: "Test", postalCode: "95126" });
const registry = new ChannelRegistry([
  swansonAdapter,
  gncAdapter,
  amazonAdapter,
  wholefoods,
  costcoAdapter(),
]);
const resolver = listingIdentityResolver(registry);
const source = { sourceKey: "capture-1", dataset: "test" };

it.each([
  {
    channel: "gnc",
    url: "https://www.gnc.com/energy/877080.html",
    listingId: "877080",
    externalId: "877080",
    id: "7237a9b049a13cf122b51f72ae2cdb2c46b26baab8d1f7d004300860f37ad03c",
  },
  {
    channel: "swanson",
    url: "https://www.swansonvitamins.com/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr",
    listingId: "healthy-origins-natural-d-ribose-10-6-oz-pwdr",
    externalId: "HOR083",
    id: "2addecc924b260559feb5268680a9a141e2a83dea24fafa5ea4db0276eb4d425",
  },
  {
    channel: "amazon",
    url: "https://www.amazon.com/gp/product/b002cqu54q?tag=tracking",
    listingId: "B002CQU54Q",
    externalId: "B002CQU54Q",
    id: "b66b276da1240eb5080278c3b8870d8e580914ec0b0d06562f1475a67cafb183",
  },
])("preserves the $channel history key through its real adapter", ({ id, ...page }) => {
  expect(identifyListing({ ...page, ...source }, resolver)).toMatchObject({
    id,
    basis: "external-id",
    externalId: page.externalId,
  });
});

it("gets an absent history ID from the adapter address", () => {
  expect(
    resolver.resolve({
      channel: "wholefoods",
      url: "https://www.wholefoodsmarket.com/grocery/product/nordic-naturals-b002cqu54q",
      listingId: "B002CQU54Q",
      externalId: null,
    }),
  ).toMatchObject({ site: "wholefoodsmarket.com", externalId: "B002CQU54Q" });
});

it.each([
  { channel: "amazon", url: "https://example.com/dp/B002CQU54Q", listingId: "B002CQU54Q" },
  { channel: "amazon", url: "https://www.amazon.com/dp/B002CQU54Q", listingId: "B000000000" },
  { channel: "missing", url: "https://example.com/p/1", listingId: "1" },
])("refuses an unverified address or mismatched product: $channel $listingId", (page) => {
  expect(identifyListing({ ...page, externalId: page.listingId, ...source }, resolver).basis).toBe(
    "unresolved",
  );
});

it("uses a newly registered site's address without adding it to the application", () => {
  const productAddress = vi.fn(() => ({
    url: "https://custom.example/products/one?option=two",
    listingId: "custom-key",
    variantId: "two",
  }));
  const adapter: ChannelAdapter = { ...gncAdapter, id: "dtc", productAddress };
  const identities = listingIdentityResolver(new ChannelRegistry([adapter]));
  const page = {
    channel: "dtc",
    url: "https://custom.example/alias",
    listingId: "custom-key",
    externalId: "sku",
  };
  expect(identifyListing({ ...page, ...source }, identities)).toMatchObject({
    site: "custom.example",
    externalId: "sku",
    url: "https://custom.example/products/one?option=two",
  });
  expect(productAddress).toHaveBeenCalledWith(page.url);
});

it("shares formulas by adapter declaration, in both directions", () => {
  const families = formulaFamilies(registry);
  expect(families.channels("amazon")).toEqual(["amazon", "wholefoods"]);
  expect(families.channels("wholefoods")).toEqual(["amazon", "wholefoods"]);
  expect(families.channels("swanson")).toEqual(["swanson"]);
  expect(families.channels("costco")).toEqual(["costco"]);
  expect(families.channels("unregistered")).toEqual(["unregistered"]);
});

it("changes formula families with the registry, including channels without a declaration", () => {
  const families = formulaFamilies(
    new ChannelRegistry([
      { ...gncAdapter, formulaFamily: "shared-sku" },
      { ...swansonAdapter, formulaFamily: "shared-sku" },
      { ...gncAdapter, id: "dtc" },
      { ...gncAdapter, id: "costco" },
    ]),
  );
  expect(families.channels("gnc")).toEqual(["gnc", "swanson"]);
  expect(families.channels("dtc")).toEqual(["dtc"]);
  expect(families.channels("costco")).toEqual(["costco"]);
});

it("keys Costco metrics by online ID rather than warehouse item number", () => {
  expect(
    resolver.resolve({
      channel: "costco",
      url: "https://www.costco.com/p/-/100029983",
      listingId: "100029983",
      externalId: null,
    }),
  ).toMatchObject({ site: "costco.com", externalId: "100029983" });
});

it("projects Costco's configured warehouse into the shared metrics store field", () => {
  const html = readFileSync(
    new URL("../../../packages/channels/costco/src/fixtures/product.html", import.meta.url),
    "utf8",
  );
  const product = costcoAdapter().parseProduct({
    html,
    url: "https://www.costco.com/p/-/100029983",
    capturedAt: "2026-10-01T00:00:00Z",
  });
  expect(commerceMetrics(product.commerce)).toMatchObject({
    price: "26.99",
    extras: {
      store: { id: "669", label: "Southlake" },
      commerce: { context: expect.arrayContaining(["costco-item:648220"]) },
    },
  });
});
