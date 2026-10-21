import { describe, expect, it } from "vitest";
import { simpleLabel, decodeSimple } from "../../testing/simple-label.js";
import { defined } from "../../testing/defined.js";
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
  it("keeps printed list separators and a minor-ingredients subheading between cited items", () => {
    for (const ingredients of [
      "Cellulose | Silica",
      "Cellulose in a base of Silica",
      "Cellulose, Contains Less Than 2% Of Each Of The Following: Silica",
    ]) {
      expect(decodeSimple(simpleLabel({ ingredients })).codes).toEqual([]);
    }
  });
  it("accepts six cited electrolyte ingredients separated only by comma and space", () => {
    const items = ["sodium", "potassium", "magnesium", "calcium", "chloride", "phosporous"];
    const fixture = simpleLabel({ items, ingredients: items.join(", ") });
    fixture.lines[6] = `Ingredients ${items.join(", ")}`;
    defined(fixture.wire.otherIngredients).heading.text = "Ingredients";
    expect(decodeSimple(fixture).codes).toEqual([]);
  });
  it("keeps a genuine boundary error after a heading is corrected", () => {
    const fixture = simpleLabel({
      ingredients: "sodium, potassium, magnesium",
      items: ["sodium", "magnesium"],
    });
    fixture.lines[6] = "Ingredients sodium, potassium, magnesium";
    defined(fixture.wire.otherIngredients).heading.text = "Ingredients";
    expect(decodeSimple(fixture).codes).toContain("LABEL.INGREDIENT_BOUNDARY");
  });
  it("identifies two dose-bearing formula rows placed under Contains", () => {
    const items = ["Vitamin C (as Ascorbic Acid) 2.35 g", "Zinc 15 mg"];
    const fixture = simpleLabel({ items, ingredients: items.join(", ") });
    fixture.lines.fill("", 0, 6);
    fixture.lines[6] = `Contains: ${items.join(", ")}`;
    fixture.wire.formula = null;
    defined(fixture.wire.otherIngredients).heading.text = "Contains:";
    const result = decodeSimple(fixture);
    expect(result.codes).toContain("LABEL.INGREDIENT_ITEMS_ARE_ROWS");
    expect(result.codes).not.toContain("LABEL.COMPLETENESS_CONFLICT");
    expect(result.codes).toEqual(["LABEL.INGREDIENT_ITEMS_ARE_ROWS"]);
    expect(result.candidate.formula).toBeNull();
    expect(result.status).toBe("review");
  });
  it("keeps a source's mismatched bracket when neighboring cited items delimit it", () => {
    expect(
      decodeSimple(
        simpleLabel({
          ingredients: "Vegetables [Carrot, Celery, Onion), Salt",
          items: ["Vegetables [Carrot, Celery, Onion)", "Salt"],
        }),
      ).codes,
    ).toEqual([]);
  });
  it("still reviews a truncated ingredient and an incomplete minor heading", () => {
    expect(
      decodeSimple(simpleLabel({ items: ["Hyaluronic -"], ingredients: "Hyaluronic -" })).codes,
    ).toContain("LABEL.INGREDIENT_BOUNDARY");
    expect(
      decodeSimple(simpleLabel({ ingredients: "Cellulose, Less than 2 of Silica" })).codes,
    ).toContain("LABEL.INGREDIENT_BOUNDARY");
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
