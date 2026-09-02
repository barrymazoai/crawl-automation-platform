import { describe, expect, it } from "vitest";
import { buildGncBatchPrompt, packHint, parseGncBatchOutput, type GncCleanInput } from "./semantic.js";

const input: GncCleanInput = {
  sku: "379969",
  title: "100% Whey Protein Powder",
  description: "Supports muscle recovery",
  details: "Powder",
  labelText: "Nutrition Facts Protein 25 g",
  labelIngredients: ["Protein"],
};

describe("GNC semantic cleanup", () => {
  it("treats each GNC SKU independently and grounds formula in label evidence", () => {
    const prompt = buildGncBatchPrompt([input], ["Muscle Health"]);
    expect(prompt).toContain("### SKU 379969");
    expect(prompt).toContain("LABEL_TEXT:");
    expect(prompt).toContain("Prefer explicit function/benefit claims in DETAILS");
    const result = parseGncBatchOutput(JSON.stringify([{
      sku: "379969",
      scope_decision: "included",
      scope_reason: "nutrition_product",
      scope_evidence: ["Nutrition Facts Protein 25 g"],
      health_functions: ["Muscle Health"],
      product_form: "powder",
      ingredients: ["Protein"],
    }]), [input], ["Muscle Health"]);
    expect(result.results[0]).toMatchObject({ sku: "379969", scopeDecision: "included", productForm: "powder", ingredients: ["Protein"] });
  });

  it("falls back to exact label ingredients but excludes empty formulas", () => {
    const result = parseGncBatchOutput(JSON.stringify([{ sku: "379969", scope_decision: "included", scope_reason: "nutrition_product", scope_evidence: ["label"], health_functions: [], product_form: "powder", ingredients: [] }]), [input], []);
    expect(result.results[0]?.ingredients).toEqual(["Protein"]);
  });
});

describe("bundle_or_pack 的边界", () => {
  it("同一产品的数量装不算套装，只有混合不同产品/口味的才算", () => {
    const prompt = buildGncBatchPrompt([input], ["Muscle Health"]);
    expect(prompt).toContain("bundle_or_pack means the listing combines DIFFERENT products or flavors");
    expect(prompt).toContain("12-Pack");
    expect(prompt).toContain("is NOT a bundle");
    expect(prompt).toContain("variety pack");
  });
});

describe("packHint 确定性判定", () => {
  it("数量装 vs 混合套装", () => {
    expect(packHint("Chocolate Balanced Nutrition Shake — Carton / 12-Pack")).toBe("quantity_pack");
    expect(packHint("Pro Elite Protein Shake — Bottle / 24-Pack (24 x 11.5 fl. oz.)")).toBe("quantity_pack");
    expect(packHint("Whey Protein, Case of 6")).toBe("quantity_pack");
    expect(packHint("Creatine Candy™ - Variety Pack - 120 Chewable Tablets")).toBe("variety_or_mixed");
    expect(packHint("Pre-Workout + Creatine Stack")).toBe("variety_or_mixed");
    expect(packHint("Starter Kit")).toBe("variety_or_mixed");
    expect(packHint("100% Whey Protein Powder")).toBeNull();
  });
  it("数量装 SKU 在 prompt 里带 PACK_HINT，混合套装也带、普通商品不带", () => {
    const pack = buildGncBatchPrompt([{ ...input, title: "Shake — Carton / 12-Pack" }], ["Muscle Health"]);
    expect(pack).toContain("PACK_HINT: multi-unit quantity pack");
    const mixed = buildGncBatchPrompt([{ ...input, title: "Variety Pack" }], ["Muscle Health"]);
    expect(mixed).toContain("PACK_HINT: mixed/variety pack");
    expect(buildGncBatchPrompt([input], ["Muscle Health"])).not.toContain("PACK_HINT: ");
  });
});
