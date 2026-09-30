import { describe, expect, it } from "vitest";
import { factsFromHtml, factsTextComplete, factsTextFromHtml } from "./facts-text.js";

// Swanson product page facts text (healthy-origins-vitamin-k2-mk-7-100-mcg-180-veg-sgels, 2026-09-28).
const swanson =
  " Supplement Facts Serving Size 1 Softgel Servings Per Container 180 Amount Per Serving % Daily Value" +
  " Vitamin K2 (from Natto)(as Menaquinone-7) 100 mcg † †Daily Value not established Other Ingredients:" +
  " Vegetarian Softgel (Non-GMO Modified Tapioca Starch, Glycerin, Purified Water), Organic Extra Virgin" +
  " Olive Oil, Yellow Beeswax, Sunflower Lecithin.";

describe("facts text completeness", () => {
  it("complete facts text: serving size, an amount and other ingredients", () => {
    expect(factsTextComplete(swanson)).toEqual({ complete: true, reasons: [], amounts: 1 });
    const html = `<pre>${swanson.replace(/&/g, "&amp;")}</pre>`;
    expect(factsTextComplete(factsTextFromHtml(html)).complete).toBe(true);
  });

  it("anything missing keeps the images", () => {
    const noAmount =
      "Supplement Facts Serving Size 1 Softgel Calories 20 Other Ingredients: Gelatin";
    expect(factsTextComplete(noAmount).reasons).toEqual(["FACTS.AMOUNTS_MISSING"]);
    expect(factsTextComplete("Serving Size 1 Softgel Vitamin K2 100 mcg").reasons).toEqual([
      "FACTS.OTHER_INGREDIENTS_MISSING",
    ]);
    expect(factsTextComplete("Vitamin K2 100 mcg Other Ingredients: Gelatin").reasons).toEqual([
      "FACTS.SERVING_SIZE_MISSING",
    ]);
    const headings =
      "Supplement Facts Serving Size Amount Per Serving % Daily Value Other Ingredients:";
    expect(factsTextComplete(headings).reasons).toEqual([
      "FACTS.AMOUNTS_MISSING",
      "FACTS.OTHER_INGREDIENTS_MISSING",
    ]);
    expect(factsTextComplete(null)).toMatchObject({
      complete: false,
      reasons: ["FACTS.TEXT_MISSING"],
    });
  });

  it("reads a facts table (GNC) with the same rule", () => {
    const table =
      "<table><tr><td>Serving Size 2 Softgels</td></tr><tr><td>EPA</td><td>650 mg</td></tr></table>" +
      "<p>Other Ingredients: Purified fish oil, gelatin</p>";
    expect(factsFromHtml(table)).toMatchObject({ complete: true, missing: [] });
    expect(factsFromHtml(null)).toEqual({
      text: null,
      complete: false,
      missing: ["FACTS.TEXT_MISSING"],
    });
  });
});
