import { describe, expect, it } from "vitest";
import { simpleLabel, decodeSimple } from "../../testing/simple-label.js";
import { completeIngredientItem, ingredientGap } from "./ingredient-boundaries.js";

describe("anchored ingredient boundaries", () => {
  it.each([
    ["softgel capsule [gelatin, glycerin, purified water, annatto (color)]", "Silica"],
    ["Raw, wild spruce needle extract", "Water"],
    ["Natural and Artificial Flavors", "Silica"],
  ])("keeps a complete compound item %s", (...items) => {
    expect(decodeSimple(simpleLabel({ items, ingredients: items.join(" and ") })).codes).toEqual(
      [],
    );
  });
  it("accepts sentence boundaries and locates a repeated name after and", () => {
    const items = ["Vegetable Cellulose Capsule.", "Cellulose"];
    expect(decodeSimple(simpleLabel({ items, ingredients: items.join(" ") })).codes).toEqual([]);
    expect(
      decodeSimple(
        simpleLabel({
          items: ["Vegetable Cellulose Capsule", "Cellulose"],
          ingredients: "Vegetable Cellulose Capsule and Cellulose",
        }),
      ).codes,
    ).toEqual([]);
  });
  it.each([
    { ingredients: "Cellulose, Zinc, Silica", items: ["Cellulose", "Silica"] },
    { ingredients: "Natural and Artificial Flavors", items: ["Natural", "Artificial Flavors"] },
    { ingredients: "Cellulose, Silica", items: ["Cellulose, Silica"] },
    { ingredients: "softgel [gelatin, water)", items: ["softgel [gelatin, water)"] },
    { ingredients: "Cellulose. CHERRY: Other Ingredients: Silica", items: ["Cellulose", "Silica"] },
  ])("refuses skipped, merged, unbalanced or cross-variant items", (options) => {
    expect(decodeSimple(simpleLabel(options)).codes).toContain("LABEL.INGREDIENT_BOUNDARY");
  });
  it("rejects overlapping anchors and unmatched outer brackets", () => {
    expect(
      ingredientGap(
        "Water",
        { text: "Water", start: 0, end: 5 },
        { text: "Water", start: 0, end: 5 },
      ),
    ).toBeNull();
    expect(completeIngredientItem("capsule [gelatin (water]")).toBe(false);
  });
});
