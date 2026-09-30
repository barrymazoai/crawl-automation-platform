import { expect, it } from "vitest";
import { factsTextComplete, factsTextFromHtml } from "./facts-text.js";

// Swanson product page embedded supplementFacts text (healthy-origins-vitamin-k2-mk-7-100-mcg-180-veg-sgels, 2026-09-28).
const swanson = " Supplement Facts Serving Size 1 Softgel Servings Per Container 180 Amount Per Serving % Daily Value Vitamin K2 (from Natto)(as Menaquinone-7) 100 mcg † †Daily Value not established Other Ingredients: Vegetarian Softgel (Non-GMO Modified Tapioca Starch, Glycerin, Purified Water), Organic Extra Virgin Olive Oil, Yellow Beeswax, Sunflower Lecithin.";
it("complete facts text: serving size, an amount and other ingredients", () => {
  expect(factsTextComplete(swanson)).toEqual({ complete: true, reasons: [], amounts: 1 });
  expect(factsTextComplete(factsTextFromHtml(`<pre>${swanson.replace(/&/g, "&amp;")}</pre>`)).complete).toBe(true);
});
it("anything missing keeps the images", () => {
  expect(factsTextComplete("Supplement Facts Serving Size 1 Softgel Calories 20 Other Ingredients: Gelatin").reasons).toEqual(["FACTS.AMOUNTS_MISSING"]);
  expect(factsTextComplete("Serving Size 1 Softgel Vitamin K2 100 mcg").reasons).toEqual(["FACTS.OTHER_INGREDIENTS_MISSING"]);
  expect(factsTextComplete("Vitamin K2 100 mcg Other Ingredients: Gelatin").reasons).toEqual(["FACTS.SERVING_SIZE_MISSING"]);
  expect(factsTextComplete("Supplement Facts Serving Size Amount Per Serving % Daily Value Other Ingredients:").reasons)
    .toEqual(["FACTS.AMOUNTS_MISSING", "FACTS.OTHER_INGREDIENTS_MISSING"]);
  expect(factsTextComplete(null)).toMatchObject({ complete: false, reasons: ["FACTS.TEXT_MISSING"] });
});
