import { describe, expect, it } from "vitest";
import { createDtcChannelHooks } from "./channels/dtc.js";

const hooks = createDtcChannelHooks();
const base = { sku: "x", healthFunctions: [], productForm: "powder", ingredients: [], scopeEvidence: ["原证据"] } as any;
const facts = (rows: number) => ({ facts: { rows: Array.from({ length: rows }, (_, i) => ({ name: `n${i}` })) } } as any);

describe("join 处按到齐的证据修订 scope", () => {
  it("因缺配方证据被排除、但成分表已提取到 → 翻案为入库", () => {
    const out = hooks.reviseScope!({ ...base, scopeDecision: "excluded", scopeReason: "ingredients_and_formula_missing" }, facts(12));
    expect(out.scopeDecision).toBe("included");
    expect(out.scopeReason).toBe("nutrition_product");
    expect(out.scopeEvidence[0]).toContain("12 行");
    expect(out.scopeEvidence).toContain("原证据");
  });

  it("成分表没拿到或行数太少 → 保持排除", () => {
    for (const f of [null, facts(0), facts(1)]) {
      const out = hooks.reviseScope!({ ...base, scopeDecision: "excluded", scopeReason: "ingredients_and_formula_missing" }, f);
      expect(out.scopeDecision).toBe("excluded");
    }
  });

  it("与证据无关的排除理由一律不翻案", () => {
    for (const reason of ["non_nutrition_product", "bundle_or_pack"] as const) {
      const out = hooks.reviseScope!({ ...base, scopeDecision: "excluded", scopeReason: reason }, facts(20));
      expect(out.scopeDecision).toBe("excluded");
      expect(out.scopeReason).toBe(reason);
    }
  });

  it("本来就入库的不动", () => {
    const input = { ...base, scopeDecision: "included", scopeReason: "nutrition_product" };
    expect(hooks.reviseScope!(input, facts(20))).toBe(input);
  });
});
