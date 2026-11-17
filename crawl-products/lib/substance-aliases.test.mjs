import { describe, expect, it } from "vitest";

import { SUBSTANCE_ALIASES, SUBSTANCE_LABEL_RULES } from "./substance-aliases.data.mjs";
import { resolveSubstanceHint } from "./substance-aliases.mjs";

describe("Supply Smart substance aliases (KAN-285)", () => {
  it("loads the generated list", () => {
    expect(SUBSTANCE_ALIASES.length).toBe(250);
    expect(SUBSTANCE_LABEL_RULES.length).toBe(8);
    // no chains: a keeper resolves to itself (names that differ only in case resolve to its exact spelling)
    for (const entry of SUBSTANCE_ALIASES) {
      const resolved = resolveSubstanceHint({ substance: entry.substance, form: entry.form ?? "" });
      expect(resolved).toEqual({ substance: entry.substance, form: entry.form ?? "", rewrite: null });
    }
  });

  it("sends a merged substance as its keeper, keeping the form", () => {
    expect(resolveSubstanceHint({ name: "Thiamine HCl", substance: "Thiamine", form: "Thiamine HCl" })).toEqual({
      substance: "Vitamin B1",
      form: "Thiamine HCl",
      rewrite: { kind: "merge", from: "Thiamine" },
    });
  });

  it("matches case and spacing aside, and sends the keeper's exact spelling", () => {
    expect(resolveSubstanceHint({ name: "Notoginseng", substance: "panax  notoginseng" }).substance)
      .toBe("Panax Notoginseng");
  });

  it("sends a substance turned into a form as keeper + form", () => {
    expect(resolveSubstanceHint({ name: "Vitamin K2 (MK-7)", substance: "Vitamin K2", form: "MK-7" })).toEqual({
      substance: "Vitamin K",
      form: "Vitamin K2",
      rewrite: { kind: "form", from: "Vitamin K2" },
    });
  });

  it("moves excipient labels off the nutrient", () => {
    expect(resolveSubstanceHint({ name: "Magnesium Stearate.", substance: "Magnesium", form: "Magnesium Stearate" }))
      .toEqual({ substance: "Magnesium Stearate", form: "", rewrite: { kind: "label", from: "Magnesium" } });
    expect(resolveSubstanceHint({ name: "Silica", substance: "Silica" }).substance).toBe("Silicon Dioxide");
  });

  it("fixes the spelling of a keeper sent in another case", () => {
    expect(resolveSubstanceHint({ name: "L. acidophilus", substance: "Lactobacillus acidophilus" }).substance)
      .toBe("Lactobacillus Acidophilus");
  });

  it("leaves current names and bare names alone", () => {
    expect(resolveSubstanceHint({ name: "Magnesium Glycinate", substance: "Magnesium", form: "Magnesium Glycinate" }))
      .toEqual({ substance: "Magnesium", form: "Magnesium Glycinate", rewrite: null });
    expect(resolveSubstanceHint({ name: "Thiamine" })).toEqual({ substance: "", form: "", rewrite: null });
  });
});
