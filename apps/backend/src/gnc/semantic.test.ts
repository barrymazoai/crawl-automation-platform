import { describe, expect, it } from "vitest";
import { buildGncBatchPrompt, parseGncBatchOutput, type GncCleanInput } from "./semantic.js";

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
