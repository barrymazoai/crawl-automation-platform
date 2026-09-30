import { beforeAll, describe, expect, it } from "vitest";
import { amazonAdapter, type AmazonRendered } from "./index.js";
import type { ParsedProduct } from "@crawl-automation/channels-core";
import { savedPage, savedPaths } from "./testing/saved-pages.js";

const cases = [
  {
    path: savedPaths.fish,
    brand: "Nature's Bounty",
    title: "Nature's Bounty Fish Oil 300mg Omega-3, 120 Softgels",
    price: "10.45",
    listPrice: "14.09",
    rating: "4.8",
    reviews: "6320",
    images: 6,
    image: "71m62G2Sr3L",
    others: 6,
    parent: "B0CWSXGT5V",
    difference: "flavour",
    ingredients: "Fish oil, gelatin, vegetable glycerin",
    otherIngredients: false,
  },
  {
    path: savedPaths.collagen,
    brand: "Horbäach",
    title: "Horbäach Collagen Peptides | 90 Caplets | Skin and Nail Health",
    price: "9.99",
    listPrice: null,
    rating: "4.4",
    reviews: "19",
    images: 7,
    image: "718ZuvhraGL",
    others: 0,
    parent: null,
    difference: null,
    ingredients: "Vitamin C, Biotin, Collagen Peptides Type I & II",
    otherIngredients: true,
  },
  {
    path: savedPaths.fishLater,
    brand: "Nature's Bounty",
    title: "Nature's Bounty Fish Oil 300mg Omega-3, 120 Softgels",
    price: "10.45",
    listPrice: "14.09",
    rating: "4.8",
    reviews: "6331",
    images: 6,
    image: "71m62G2Sr3L",
    others: 5,
    parent: "B0CWSXGT5V",
    difference: "flavour",
    ingredients: "Fish oil, gelatin, vegetable glycerin",
    otherIngredients: false,
  },
  {
    path: savedPaths.manganese,
    brand: "Best Naturals",
    title: "Best Naturals Manganese (Manganese Amino Acid Chelate) 8 mg- 250 Tablets",
    price: null,
    listPrice: null,
    rating: "4.4",
    reviews: "84",
    images: 7,
    image: "710GmmAifNL",
    others: 0,
    parent: null,
    difference: null,
    ingredients: "Manganese, Di Calcium Phosphate",
    otherIngredients: false,
  },
  {
    path: savedPaths.vitamin,
    brand: "Nature's Bounty",
    title:
      "Nature's Bounty Vitamin B12 2500 mcg, Cellular Energy Support, for Energy Metabolism, " +
      "Heart & Nervous System Health, 75 Quick Dissolve Tablets (Pack of 3)",
    price: "19.99",
    listPrice: "33.93",
    rating: "4.8",
    reviews: "27140",
    images: 7,
    image: "81l-aPXdMrL",
    others: 3,
    parent: "B0CWSSB35D",
    difference: "pack-count",
    ingredients: "Other Ingredients: Mannitol, Crospovidone",
    otherIngredients: true,
  },
];

for (const sample of cases) {
  const fixture = savedPage(sample.path);
  describe.skipIf(!fixture.available)(fixture.name, () => {
    let parsed: ParsedProduct<AmazonRendered>;
    beforeAll(() => {
      parsed = amazonAdapter.parseProduct(fixture.read());
    });

    it("reads the page-owned ASIN, title and decoded brand byline", () => {
      expect(parsed.identity).toEqual({ listingId: fixture.asin, variantId: null });
      expect(amazonAdapter.externalId?.(parsed)).toBe(fixture.asin);
      expect(parsed.evidence).toMatchObject({
        channel: "amazon",
        listingId: fixture.asin,
        title: sample.title,
        brandRaw: sample.brand,
      });
    });

    it("reads the one-time price, list price, rating, reviews and availability", () => {
      expect(parsed.commerce).toMatchObject({
        sku: fixture.asin,
        price: sample.price,
        currency: sample.price ? "USD" : null,
        listPrice: sample.listPrice,
        rating: sample.rating,
        reviewCount: sample.reviews,
        availability: sample.price
          ? "In Stock"
          : "Currently unavailable. We don't know when or if this item will be back in stock.",
        priceStatus: sample.price ? "observed" : "unavailable",
      });
    });

    it("keeps every selected high-resolution gallery image", () => {
      const images = parsed.evidence.imageCandidates;
      expect(images).toHaveLength(sample.images);
      expect(images[0]?.url).toBe(
        `https://m.media-amazon.com/images/I/${sample.image}._AC_SL1500_.jpg`,
      );
      expect(
        images.every(
          (image) =>
            image.url.endsWith("._AC_SL1500_.jpg") &&
            image.basis === "selected-gallery" &&
            image.variantId === null &&
            !image.verifiedOriginal,
        ),
      ).toBe(true);
      expect(new Set(images.map((image) => image.url)).size).toBe(sample.images);
    });

    it("retains incomplete ingredients and excludes directions and disclaimers", () => {
      expect(parsed.facts.text).toContain(sample.ingredients);
      expect(parsed.facts.complete).toBe(false);
      expect(parsed.facts.missing).toEqual(
        expect.arrayContaining([
          "FACTS.SERVING_SIZE_MISSING",
          "FACTS.AMOUNTS_MISSING",
          "AMAZON.FACTS_LABEL_MISSING",
        ]),
      );
      expect(parsed.facts.missing.includes("FACTS.OTHER_INGREDIENTS_MISSING")).toBe(
        !sample.otherIngredients,
      );
      expect(parsed.facts.text).not.toMatch(/Safety Information|Directions|Legal Disclaimer/);
      expect(parsed.evidence.detailsHtml).toContain("feature-bullets");
    });

    it("maps variation ASINs, all dimension labels and conservative reuse classification", () => {
      const family = amazonAdapter.productFamily?.(parsed);
      expect(parsed.variants).toHaveLength(sample.others);
      expect(parsed.rendered.family?.parentAsin ?? null).toBe(sample.parent);
      expect(family?.differsBy ?? null).toBe(sample.difference);
      expect(family?.members.length ?? 0).toBe(sample.others);
      expect(
        parsed.variants.every(
          (item) =>
            item.listingId !== fixture.asin &&
            item.url === `https://www.amazon.com/dp/${item.listingId}`,
        ),
      ).toBe(true);
      if (family) {
        expect(family.selectedLabel).toContain(" / ");
        expect(family.members.every((member) => member.label.includes(" / "))).toBe(true);
      }
    });

    it("round-trips planner evidence with the same incomplete-facts decision", () => {
      const planning = amazonAdapter.planning;
      const projection = planning?.projection(parsed.rendered);
      const read = planning?.read(
        JSON.parse(JSON.stringify(projection)),
        fixture.read().url,
        parsed.identity,
      );
      expect(read).toEqual({ evidence: parsed.evidence, facts: parsed.facts });
      expect(parsed.evidence.warnings).toEqual([]);
    });
  });
}
