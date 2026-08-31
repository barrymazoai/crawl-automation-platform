import { describe, expect, it } from "vitest";
import { parseSwansonConstructorPage, swansonVariantAttrsFromRaw } from "./pipeline.js";

describe("Swanson fixed adapter", () => {
  it("expands Constructor variations into independent Swanson handles", () => {
    const parsed = parseSwansonConstructorPage({ response: {
      total_num_results: 1,
      results: [{
        value: "Creatine Gummies",
        data: { id: "P-SW1969", brand: "Swanson Vitamins", form: "Gummies", url: "wild-berry", variation_id: "SW1970" },
        variations: [
          { data: { url: "wild-berry", variation_id: "SW1970", flavor: "Wild Berry" } },
          { data: { url: "watermelon", variation_id: "SW1969", flavor: "Watermelon" } },
        ],
      }],
    } });
    expect(parsed.total).toBe(1);
    expect(parsed.resultCount).toBe(1);
    expect(parsed.entries.map((entry) => [entry.handle, entry.data.variation_id])).toEqual([
      ["wild-berry", "SW1970"],
      ["watermelon", "SW1969"],
    ]);
  });

  it("splits Swanson pfdesc into a canonical size and form", () => {
    expect(swansonVariantAttrsFromRaw({
      flavor: "Dark Chocolate",
      pfdesc: "22 oz Pwdr",
      form: null,
    })).toEqual({ flavor: "Dark Chocolate", size: "22 oz", form: "powder" });
    expect(swansonVariantAttrsFromRaw({
      option1: "Default Title",
      pfdesc: "50 Billion CFU 60 Caps",
      potent: "50 Billion CFU",
      form: "Caps",
    })).toEqual({ size: "60 Count", strength: "50 Billion CFU", form: "capsule" });
  });
});
