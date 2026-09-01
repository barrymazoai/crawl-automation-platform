import { describe, expect, it } from "vitest";
import {
  buildProductUnifyPrompt,
  groupInputsIntoBatches,
  canonicalVariantStrength,
  canonicalVariantForm,
  completeProductNameWithVariant,
  parseProductUnifyOutput,
  productVariantSchema,
  type ProductUnifyInput,
} from "./product-unify.js";

const input: ProductUnifyInput = {
  clientRef: "gnc:379969",
  channel: "gnc",
  titleRaw: "Optimum Nutrition Gold Standard 100% Whey Protein Powder, Vanilla Cream, 4 lb",
  brand: "Optimum Nutrition",
  structuredVariant: { flavor: "Vanilla Cream", size: "4 lb" },
  attrsRaw: { flavor: "Vanilla Cream", size: "4 lb", upc: "048107252779", category: "Protein" },
  productFormHint: "powder",
};

describe("Product Unify", () => {
  it("preserves channel attributes and adds title-derived strict dimensions", () => {
    const outcome = parseProductUnifyOutput(JSON.stringify([{
      client_ref: "gnc:379969",
      product_name: "Gold Standard 100% Whey — Vanilla Cream, 4 lb, Powder",
      base_name: "Gold Standard 100% Whey",
      variant: { flavor: "Vanilla", size: "5 lb", form: "Powders" },
      variant_confidence: 94,
    }]), [input]);

    expect(outcome.results[0]).toMatchObject({
      productName: "Gold Standard 100% Whey — Vanilla Cream, 4 lb, Powder",
      baseName: "Gold Standard 100% Whey",
      variant: { flavor: "Vanilla Cream", size: "4 lb", form: "powder" },
      variantConfidence: 94,
      variantSource: "ai_extract",
      attrsRaw: input.attrsRaw,
    });
  });

  it("drops illegal dimensions and caps confidence below the auto-resolve threshold", () => {
    const outcome = parseProductUnifyOutput(JSON.stringify([{
      client_ref: "gnc:379969",
      product_name: "Gold Standard 100% Whey",
      base_name: "Gold Standard 100% Whey",
      variant: { flavor: "Vanilla Cream", upc: "048107252779" },
      variant_confidence: 99,
    }]), [{ ...input, structuredVariant: {} }]);

    expect(outcome.results[0]?.variant).toEqual({ flavor: "Vanilla Cream" });
    expect(outcome.results[0]?.variantConfidence).toBe(69);
    expect(outcome.problems.join(" ")).toContain("upc");
  });

  it("rejects dirty multi-form values and aligns by client_ref", () => {
    const second = { ...input, clientRef: "amazon:B000000001", structuredVariant: {} };
    const outcome = parseProductUnifyOutput(JSON.stringify([
      { client_ref: second.clientRef, product_name: "Second", base_name: "Second", variant: { form: "Liquid,Capsule,Softgels" }, variant_confidence: 92 },
      { client_ref: input.clientRef, product_name: "First", base_name: "First", variant: input.structuredVariant, variant_confidence: 100 },
    ]), [input, second]);

    expect(outcome.results.map((item) => item.clientRef)).toEqual([input.clientRef, second.clientRef]);
    expect(outcome.results[1]?.variant).toEqual({});
    expect(outcome.results[1]?.variantConfidence).toBe(69);
    expect(outcome.problems.join(" ")).toContain("封闭词表");
  });

  it("uses channel_attrs when every variant dimension is structured", () => {
    const outcome = parseProductUnifyOutput(JSON.stringify([{
      client_ref: input.clientRef,
      product_name: "Gold Standard 100% Whey — Vanilla Cream, 4 lb",
      base_name: "Gold Standard 100% Whey",
      variant: input.structuredVariant,
      variant_confidence: 100,
    }]), [input]);
    expect(outcome.results[0]?.variantSource).toBe("channel_attrs");
  });

  it("keeps the schema strict and maps common form aliases", () => {
    expect(productVariantSchema.safeParse({ flavor: "Vanilla", category: "Protein" }).success).toBe(false);
    expect(canonicalVariantForm("Soft Gels")).toBe("softgel");
    expect(canonicalVariantForm("Gelcaps")).toBe("softgel");
    expect(canonicalVariantForm("Pwdr")).toBe("powder");
    expect(canonicalVariantForm("Caps")).toBe("capsule");
  });

  it("removes Amazon CFU footnotes without reinterpreting other strength text", () => {
    expect(canonicalVariantStrength("25 Billion CFUs*")).toBe("25 Billion CFU");
    expect(canonicalVariantStrength("50 Billion CFUs*/Serving")).toBe("50 Billion CFU");
    expect(canonicalVariantStrength("1000 IU")).toBe("1000 IU");
    expect(canonicalVariantStrength("500 mg blend")).toBe("500 mg blend");
  });

  it("puts the cross-channel identity rules into the batch prompt", () => {
    const prompt = buildProductUnifyPrompt([input]);
    expect(prompt).toContain("base_name");
    expect(prompt).toContain("ONLY: flavor, size, servings, pack, strength, edition, form");
    expect(prompt).toContain("STRUCTURED_VARIANT");
  });

  it("restores verified variant dimensions omitted from the cleaned SKU name", () => {
    expect(completeProductNameWithVariant("Nature Made CoQ10 400 mg Softgels", {
      size: "90 Count",
      strength: "400 mg",
      form: "softgel",
    })).toBe("Nature Made CoQ10 400 mg Softgels, 90 Count");
    expect(completeProductNameWithVariant("Nature Made CoQ10 400 mg 90 Softgels", {
      size: "90 Count",
      strength: "400 mg",
      form: "softgel",
    })).toBe("Nature Made CoQ10 400 mg 90 Softgels");
    expect(completeProductNameWithVariant("Vitamin B-12 2500 mcg 300 Quick Dissolve Tablets, 300 tablets", {
      size: "300 tablets",
      strength: "2500 mcg",
      form: "tablet",
    })).toBe("Vitamin B-12 2500 mcg 300 Quick Dissolve Tablets");
    expect(completeProductNameWithVariant("Ultimate Omega Lemon Softgels", {
      flavor: "Lemon",
      size: "120 Count",
      servings: "60 Servings",
      strength: "1280 mg Omega-3",
      form: "softgel",
    })).toBe("Ultimate Omega Lemon Softgels, 120 Count, 60 Servings, 1280 mg Omega-3");
    expect(completeProductNameWithVariant("Nopal 180 Capsules", {
      size: "180 Count",
      servings: "90",
      form: "capsule",
    })).toBe("Nopal 180 Capsules, 90 Servings");
    expect(completeProductNameWithVariant("Nopal 180 Capsules, 180 Count, 90, 90 Servings", {
      size: "180 Count",
      servings: "90",
      form: "capsule",
    })).toBe("Nopal 180 Capsules, 90 Servings");
  });
});

describe("groupInputsIntoBatches（变体家族分组）", () => {
  const make = (clientRef: string, familyKey?: string): ProductUnifyInput => ({
    clientRef, channel: "gnc", titleRaw: clientRef, brand: "B",
    structuredVariant: {}, attrsRaw: {}, ...(familyKey ? { familyKey } : {}),
  });

  it("同一家族的成员永远在同一批，不会被批次边界拆开", () => {
    // 家族 A 有 3 个成员，若按顺序每 2 条切一次就会被拆开
    const inputs = [make("a1", "A"), make("a2", "A"), make("a3", "A"), make("b1", "B"), make("b2", "B")];
    const batches = groupInputsIntoBatches(inputs, 2);
    for (const family of ["A", "B"]) {
      const holding = batches.filter((batch) => batch.some((item) => item.familyKey === family));
      expect(holding).toHaveLength(1);
    }
  });

  it("超过批次上限的大家族整体成为一批，宁可超载也不拆开", () => {
    const big = Array.from({ length: 25 }, (_, index) => make(`x${index}`, "BIG"));
    const batches = groupInputsIntoBatches(big, 10);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(25);
  });

  it("没有 familyKey 的条目按原顺序装箱，且不超过批次上限", () => {
    const inputs = Array.from({ length: 7 }, (_, index) => make(`s${index}`));
    const batches = groupInputsIntoBatches(inputs, 3);
    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
    expect(batches.flat().map((item) => item.clientRef)).toEqual(inputs.map((item) => item.clientRef));
  });

  it("家族与散件混合时，输入一个不丢", () => {
    const inputs = [make("a1", "A"), make("s1"), make("a2", "A"), make("s2"), make("b1", "B")];
    const batches = groupInputsIntoBatches(inputs, 3);
    expect(batches.flat()).toHaveLength(inputs.length);
    expect(new Set(batches.flat().map((item) => item.clientRef)).size).toBe(inputs.length);
  });
});
