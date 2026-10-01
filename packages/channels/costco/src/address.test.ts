import { expect, it } from "vitest";
import {
  costcoBrandSearchUrl,
  costcoBrandSourceUrl,
  costcoProductAddress,
  costcoProductUrl,
} from "./address.js";

it.each(["100029983", "4000100002"])(
  "round-trips online product %s across both URL formats",
  (listingId) => {
    expect(costcoProductAddress(costcoProductUrl(listingId))).toMatchObject({
      listingId,
      variantId: null,
    });
    const address = costcoProductAddress(`/test.product.${listingId}.html?ref=ad#image`);
    expect(address).toEqual(costcoProductAddress(`/p/-/test/${listingId}`));
    expect(costcoProductAddress(address.url)).toEqual(address);
  },
);
it.each(["vitamins-herbals-dietary-supplements", "protein", "diet-nutrition", "other-category"])(
  "keeps category %s in each brand source",
  (category) => {
    const url = costcoBrandSearchUrl({ category, brand: "Nature Made & Co" });
    expect(url).toContain(`/${category}.html?refinement=brands%3DNature%20Made%20%26%20Co`);
    expect(costcoBrandSourceUrl(url)).toBe(url);
  },
);
it.each([
  "https://elsewhere.com/a.product.123.html",
  "/a.html",
  "/p/-/word",
  "http://www.costco.com/a.product.123.html",
  "https://user@www.costco.com/a.product.123.html",
])("refuses invalid product address %s", (url) =>
  expect(() => costcoProductAddress(url)).toThrow(),
);
it.each([
  "/s?keyword=Nature",
  "/protein.html",
  "/protein.html?refinement=brands=",
  "/protein.html?refinement=brands=A&refinement=brands=B",
  "/p/-/123?refinement=brands=A",
])("refuses invalid brand address %s", (url) => expect(() => costcoBrandSourceUrl(url)).toThrow());

it("reads the address Costco redirects a product to as the same product", () => {
  // ScraperAPI 2026-10-01: .product.100118306.html landed here (no Costco cookie yet).
  const landed =
    "https://www.costco.com/p/-/nature-made-coq10-200-mg-140-softgels/100118306?DM_PersistentCookieCreated=true&langId=-1";
  expect(costcoProductAddress(landed)).toMatchObject({ listingId: "100118306" });
});
