import { describe, expect, it } from "vitest";
import { ChannelProductEvidenceSchema } from "@crawl-automation/v3-contracts";
import {
  marketplaceItem,
  marketplaceLabel,
  type MarketplaceProduct,
} from "./marketplace-mapping.js";
import { marketplaceSamplesPath, required } from "./marketplace-samples.fixture.js";
import { marketplaceSamples } from "./marketplace-samples.fixture.js";

// Real samples live outside git; see docs/quality/2026-10-12-marketplace-mapping.md.
const itWithSamples = it.skipIf(!marketplaceSamplesPath);
const options = { domain: "matched-brand.example", runId: "supply-smart-partial-batch" };
const samples = marketplaceSamples();
const sample = (id: string) =>
  structuredClone(required(samples.find((entry) => entry.listingId === id)));
const itemOf = (id: string) => marketplaceItem(sample(id), options);

// Every label goes through the real collected-product schema in the fixture loader, not a made-up label shape.
describe.skipIf(!marketplaceSamplesPath)("mapping the 15 supplied marketplace runs", () => {
  for (const input of samples.filter((entry) => entry.channel !== "wholefoods")) {
    it(`${input.channel}: ${input.listingId} retains the website SKU and complete label`, () => {
      if (input.listingId === "4000349261") {
        // Real queue source differs from all three retained owners. Do not relabel it as valid.
        expect(() => marketplaceItem(input, options)).toThrow(/hash or SKU owner/u);
        return;
      }
      const item = marketplaceItem(input, options);
      const label = required(marketplaceLabel(input, options));
      expect(item.externalId).toBe(
        required(input.collection).observation.variantId ??
          required(input.collection).observation.listingId,
      );
      expect(item.domain).toBe(options.domain);
      expect(item.productName).toBe(required(input.enrichment).candidate.unifiedName);
      expect(item.titleRaw).toBe(required(input.enrichment).subject.title);
      expect(item.capturedAt).toBe(required(input.history).capturedAt);
      expect(label.channel).toBe(input.channel);
      expect(label.label.content.formula).toEqual(required(input.collection).formula);
      expect(label.label.content.otherIngredients).toEqual(
        required(input.collection).otherIngredients,
      );
      expect(label.label.evidence.assembly).toEqual(required(input.collection).assembly);
      expect(label.observation.observationId).toBe(
        required(input.collection).observation.observationId,
      );
      expect(label.listing.externalId).toBe(item.externalId);
      expect(item).not.toHaveProperty("siteKey");
      expect(item).not.toHaveProperty("facts");
      expect(item).not.toHaveProperty("variantKey");
      expect(label.listing).not.toHaveProperty("siteKey");
      expect(label).not.toHaveProperty("runId");
      expect(label.label).not.toHaveProperty("confidence");
    });
  }
  it("converts real string metrics and preserves absent values and false stock", () => {
    expect(itemOf("B00551W73C")).toMatchObject({
      price: "38.72",
      rating: 4.7,
      reviewCount: 538,
      unitsSold: 50,
      unitsSoldPeriod: "trailing_30d",
      inStock: true,
    });
    expect(itemOf("4000428043")).toMatchObject({ rating: 4.39, reviewCount: 1068, price: "20.99" });
    const unavailable = itemOf("B0FFTMHSMC");
    expect(unavailable.inStock).toBe(false);
    expect(unavailable).not.toHaveProperty("price");
    expect(unavailable).not.toHaveProperty("currency");
    expect(itemOf("solgar-omega-3-fish-oil-concentrate-120-sgels")).not.toHaveProperty("currency");
  });
  it("uses actual Amazon selected options before AI count and retains explicit Pack of 3", () => {
    expect(itemOf("B00F42FV5I")).toMatchObject({
      variant: { size: "120 Count", pack: "3", form: "softgel", strength: "1300 mg" },
      variantSource: "channel_attrs",
      variantConfidence: 99,
    });
    expect(itemOf("424743")).toMatchObject({
      variant: { size: "30 count", form: "capsule" },
      variantSource: "ai_extract",
    });
    expect(itemOf("B00551W73C").healthFunctions).toEqual([]);
  });
  it("keeps Swanson's queue handle/history SKU/website variant in their own namespaces", () => {
    const input = sample("country-life-core-daily-1-women-50-60-tabs");
    expect(required(input.history).listing.externalId).toBe("CRL530");
    expect(marketplaceItem(input, options).externalId).toBe("46318742077578");
    expect(required(marketplaceLabel(input, options)).observation.listingId).toBe("8572216246410");
  });
  for (const input of samples.filter((entry) => entry.channel === "wholefoods")) {
    it(`Whole Foods ${input.listingId} has no label and never fabricates its missing projection title`, () => {
      expect(input.collection).toBeNull();
      expect(input.enrichment).toBeNull();
      expect(() => marketplaceItem(input, options)).toThrow(/retained delivery material/u);
      const withProjection = { ...input, product: retainedWholeFoodsProjection(input) };
      expect(marketplaceItem(withProjection, options)).toMatchObject({
        externalId: input.listingId,
        inStock: false,
        extras: { store: { id: "10259", label: "The Alameda" } },
      });
      expect(marketplaceLabel(withProjection, options)).toBeNull();
    });
  }
});

// Explicit supplemental edge cases: real source records with one controlled change.
itWithSamples("scopes images, selected website options and GTIN to the current product", () => {
  const input = sample("967060");
  input.attributes = { mpn: "048107252779" };
  required(input.product).variantOptions = ["Flavor: Rainbow Sherbet", "Size: 30 Servings"];
  required(input.product).imageCandidates = [null, "foreign-variant"].map((variantId, index) => ({
    url: `https://images.example/${index}.jpg`,
    variantId,
    basis: "selected-gallery",
    verifiedOriginal: false,
  }));
  const item = marketplaceItem(input, options);
  expect(item.gtin).toBe("048107252779");
  expect(item.variant).toMatchObject({ flavor: "Rainbow Sherbet", size: "30 Servings" });
  expect(item.variantSource).toBe("channel_attrs");
  expect(item.images).toEqual([
    { clientRef: "gallery-0", url: "https://images.example/0.jpg", role: "gallery" },
  ]);
  input.attributes = { mpn: "967060" };
  expect(marketplaceItem(input, options)).not.toHaveProperty("gtin");
  input.attributes = { upc: "048107252779", gtin: "048107252780" };
  expect(marketplaceItem(input, options)).not.toHaveProperty("gtin");
});
itWithSamples(
  "falls back to retained title with no enrichment and never guesses form or pack",
  () => {
    const input = sample("424743");
    input.enrichment = null;
    const item = marketplaceItem(input, options);
    expect(item.productName).toBe(required(input.product).title);
    expect(item).not.toHaveProperty("variant");
    expect(item).not.toHaveProperty("baseName");
  },
);
itWithSamples("rejects foreign run/source/variant and mismatched attached enrichment", () => {
  for (const mutate of [
    (input: MarketplaceProduct) => {
      required(input.history).owner.runId = "foreign";
    },
    (input: MarketplaceProduct) => {
      required(input.product).variantId = "foreign";
    },
    (input: MarketplaceProduct) => {
      required(input.collection).observation.sourceId = "foreign";
    },
    (input: MarketplaceProduct) => {
      required(input.enrichment).subject.collectionOperationId = "foreign";
    },
  ]) {
    const input = sample("424743");
    mutate(input);
    expect(() => marketplaceItem(input, options)).toThrow(/hash or SKU owner/u);
  }
});
itWithSamples(
  "Whole Foods uses a same-ASIN Amazon label with separate stable ledger identity and original time",
  () => {
    const amazon = sample("B00F42FV5I");
    const wholefoods = linkedWholeFoods(amazon);
    const label = required(marketplaceLabel(wholefoods, options));
    expect(label.channel).toBe("wholefoods");
    expect(label.listing.sourceUrl).toBe(wholefoods.url);
    expect(label.observation.capturedAt).toBe(required(amazon.history).capturedAt);
    expect(label.label.content.formula).toEqual(required(amazon.collection).formula);
    expect(label.submitter.operationId).not.toBe(
      required(marketplaceLabel(amazon, options)).submitter.operationId,
    );
    expect(label).toEqual(
      marketplaceLabel(wholefoods, { ...options, runId: "another-sync-batch" }),
    );
    expect(label.listing).not.toHaveProperty("price");
    expect(marketplaceItem(wholefoods, options).price).toBe("9.99");
    required(wholefoods.collection).observation.listingId = "B000000000";
    expect(() => marketplaceLabel(wholefoods, options)).toThrow(/hash or SKU owner/u);
  },
);
function retainedWholeFoodsProjection(input: MarketplaceProduct) {
  return ChannelProductEvidenceSchema.parse({
    codec: "channel-product/1",
    channel: "wholefoods",
    listingId: input.listingId,
    variantId: null,
    url: input.url,
    title: "Explicit test double for the retained Whole Foods title (not included in samples)",
    brandRaw: input.brand,
    variantOptions: [],
    variants: [],
    detailsHtml: null,
    factsCandidates: [],
    imageCandidates: [],
    warnings: [],
  });
}
function linkedWholeFoods(amazon: MarketplaceProduct): MarketplaceProduct {
  const input = sample("B0GHDHVL1Z");
  input.listingId = amazon.listingId;
  input.url = `https://www.wholefoodsmarket.com/grocery/product/product-${amazon.listingId.toLowerCase()}`;
  required(input.history).listing = {
    channel: "wholefoods",
    externalId: input.listingId,
    url: input.url,
  };
  required(input.history).metrics.price = "9.99";
  input.product = retainedWholeFoodsProjection(input);
  input.collection = amazon.collection;
  input.enrichment = amazon.enrichment;
  input.labelHistory = amazon.history;
  return input;
}
