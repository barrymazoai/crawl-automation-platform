import { describe, expect, it } from "vitest";
import { normalizeBackfillBaseName, normalizeBackfillVariant } from "./backfill-identity.js";
import { effectiveAmazonExternalId, extractAmazonAsin, toSubmitFactsRows } from "./backfill-staging.js";

describe("Amazon backfill identity normalization", () => {
  it("uses Jakarta-compatible family and variant keys", () => {
    expect(normalizeBackfillBaseName("Optimum Nutrition Gold Standard", ["Optimum Nutrition"])).toBe("gold_standard");
    expect(normalizeBackfillVariant({ flavor: "Vanilla Cream", form: "capsule", size: "8.8 oz", pack: "Pack of 2" })).toEqual({
      attrs: {
        flavor: "vanilla_cream",
        form: "capsule",
        pack: 2,
        size: { value: 249.47580350000004, unit: "g" },
      },
      key: "flavor=vanilla_cream|form=capsule|pack=2|size=249.476g",
      unresolved: [],
    });
  });

  it("does not produce a key when a supplied dimension is unparseable", () => {
    expect(normalizeBackfillVariant({ form: "mystery delivery", size: "large" } as never)).toMatchObject({ key: null, unresolved: ["form", "size"] });
  });
});

describe("Amazon Formula to Jakarta mapping", () => {
  it("maps raw OCR rows to submitFacts names and parent positions", () => {
    expect(toSubmitFactsRows([{
      rawText: "Cinnamon (bark) 1,000 mg **",
      amountValue: 1000,
      amountUnit: "mg",
      amountMg: 1000,
      dvPercent: null,
      position: 0,
      isActive: true,
      parentIndex: null,
      taxonomy: { substance: "Cinnamon", form: "bark", category: "herbs_botanicals" },
    }] as never)).toEqual([{
      name: "Cinnamon",
      amountValue: 1000,
      amountUnit: "mg",
      dvPercent: null,
      position: 0,
      isActive: true,
      parentPosition: null,
    }]);
  });
});

describe("Amazon backfill external identity recovery", () => {
  it("derives a missing ASIN from canonical Amazon product URLs", () => {
    expect(extractAmazonAsin("https://www.amazon.com/dp/B0D3JBK6K3?ref_=share")).toBe("B0D3JBK6K3");
    expect(extractAmazonAsin("https://amazon.com/gp/product/b0d3jbk6k3/")).toBe("B0D3JBK6K3");
  });

  it("preserves a supplied external id and rejects non-product URLs", () => {
    expect(effectiveAmazonExternalId("EXISTING-ASIN", "https://amazon.com/dp/B0D3JBK6K3")).toBe("EXISTING-ASIN");
    expect(effectiveAmazonExternalId(null, "https://amazon.com/s?k=collagen")).toBeNull();
  });
});
