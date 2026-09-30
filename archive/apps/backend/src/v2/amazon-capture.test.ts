import { describe, expect, it } from "vitest";
import { CapturedProductV1Schema } from "@crawl-automation/contracts";
import { amazonBatchImagesRequired, toAmazonCapturedProduct, type AmazonRawProduct } from "./amazon-capture.js";
import { createAmazonChannelHooks } from "./channels/amazon.js";
import type { CleanResult } from "../amazon/semantic-clean.js";

function rawProduct(overrides: Partial<AmazonRawProduct["extracted"]> = {}): AmazonRawProduct {
  return {
    asin: "B000000001",
    capturedAt: new Date().toISOString(),
    sourceOrigin: "https://www.amazon.com",
    family: { parentAsin: null, members: [] },
    familyLabel: null,
    extracted: {
      title: "Brand X Vitamin D3 5000 IU Softgels",
      brand: "Brand X",
      price: "12.99",
      currency: "USD",
      rating: 4.6,
      reviewCount: 1200,
      salesRank: null,
      inStock: true,
      images: ["https://m.media-amazon.com/images/I/1.jpg"],
      itemForm: "Softgel",
      unitCount: "90 Count",
      dateFirstAvailable: null,
      manufacturer: null,
      unitsSold: 500,
      unitsSoldPeriod: "month",
      bullets: "Supports bone health",
      description: "Vitamin D3 supplement",
      aplusText: null,
      ingredientsText: "Vitamin D3 (as cholecalciferol), olive oil",
      ...overrides,
    } as AmazonRawProduct["extracted"],
  };
}

function semantic(overrides: Partial<CleanResult> = {}): CleanResult {
  return {
    asin: "B000000001",
    healthFunctions: ["Bone Health"],
    productForm: "softgel",
    ingredients: ["Vitamin D3"],
    scopeDecision: "included",
    scopeReason: "nutrition_product",
    scopeEvidence: ["Vitamin D3 5000 IU"],
    ...overrides,
  } as CleanResult;
}

describe("toAmazonCapturedProduct", () => {
  it("produces a contract-valid product with image refs as facts evidence", () => {
    const captured = toAmazonCapturedProduct(rawProduct());
    expect(CapturedProductV1Schema.safeParse(captured).success).toBe(true);
    expect(captured.externalId).toBe("B000000001");
    expect(captured.sku).toBeNull();
    expect(captured.productUrl).toBe("https://www.amazon.com/dp/B000000001");
    expect(captured.factsEvidence.htmlTable).toBeNull();
    expect(captured.factsEvidence.imageRefs).toHaveLength(1);
    expect(captured.unitsSoldText).toBe("500+ bought in past month");
  });

  it("falls back to the ASIN when the title is missing", () => {
    const captured = toAmazonCapturedProduct(rawProduct({ title: null }));
    expect(CapturedProductV1Schema.safeParse(captured).success).toBe(true);
    expect(captured.titleRaw).toBe("B000000001");
  });
});

describe("amazonBatchImagesRequired", () => {
  it("requires the image lane only when a product has images", () => {
    expect(amazonBatchImagesRequired([rawProduct()])).toBe(true);
    expect(amazonBatchImagesRequired([rawProduct({ images: [] })])).toBe(false);
  });
});

describe("amazon channel hooks", () => {
  const hooks = createAmazonChannelHooks();

  it("routes every product to the image lane (no HTML facts on Amazon)", () => {
    expect(hooks.htmlFactsReady(rawProduct())).toBe(false);
  });

  it("validate quarantines a product without any formula evidence", () => {
    const noEvidence = hooks.validate!(rawProduct(), semantic({ ingredients: [] }), { facts: null, imageIngredients: [] } as any);
    expect(noEvidence).toHaveLength(1);
    expect(noEvidence[0]).toContain("配方成分");
    expect(hooks.validate!(rawProduct(), semantic(), null)).toEqual([]);
    expect(hooks.validate!(rawProduct(), semantic({ ingredients: [] }), { facts: null, imageIngredients: ["Zinc"] } as any)).toEqual([]);
  });

  it("builds a unify input with the canonical form and returns null without a title", () => {
    const input = hooks.unifyInput(rawProduct(), semantic());
    expect(input).toMatchObject({ clientRef: "B000000001", channel: "amazon" });
    expect(input!.structuredVariant.form).toBe("softgel");
    expect(hooks.unifyInput(rawProduct({ title: null }), semantic())).toBeNull();
  });

  it("skips the join-time ingredient fallback when semantic already found ingredients", async () => {
    const ctx = { runModel: async () => { throw new Error("不应触发模型调用"); } } as any;
    expect(await hooks.augmentFacts!(ctx, rawProduct(), semantic(), null)).toBeNull();
    expect(await hooks.augmentFacts!(ctx, rawProduct({ images: [] }), semantic({ ingredients: [] }), null)).toBeNull();
  });
});
