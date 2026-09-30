import { describe, expect, it } from "vitest";
import {
  assertIngredientBoundaries,
  assertIngredientRoles,
  type AnchoredItem,
} from "./anchored-ingredients.js";
import { anchoredInput, quoteAt } from "./anchored-test-helpers.js";

function item(text: string, value: string, changes: Partial<AnchoredItem> = {}): AnchoredItem {
  return { ...quoteAt(text, value), role: "other", parentNutrientIndex: null, ...changes };
}

describe("assertIngredientRoles", () => {
  it.each([
    "Other Ingredients: Rice flour",
    "Oher Ingredients: Rice flour",
    "Contains: Milk\nOther Ingredients: Rice flour",
  ])("accepts an ingredient under the latest explicit heading: %s", (text) => {
    expect(() =>
      assertIngredientRoles([item(text, "Rice flour")], {
        input: anchoredInput(text),
        text,
        nutrients: [],
      }),
    ).not.toThrow();
  });

  it.each([
    "Rice flour",
    "Other Ingredients: Contains: Milk, Rice flour",
    "Other Ingredients: Supplement Facts\nRice flour",
    "Other Ingredients: Manufactured on shared equipment. Rice flour",
  ])("refuses a misplaced ingredient or an allergen tail: %s", (text) => {
    expect(() =>
      assertIngredientRoles([item(text, "Rice flour")], {
        input: anchoredInput(text),
        text,
        nutrients: [],
      }),
    ).toThrow(expect.objectContaining({ code: "TEXT.ROLE_INVALID" }));
  });

  it("never treats a whole allergen warning as an ingredient", () => {
    const text = "Other Ingredients: Contains: Milk";
    expect(() =>
      assertIngredientRoles([item(text, "Contains: Milk")], {
        input: anchoredInput(text),
        text,
        nutrients: [],
      }),
    ).toThrow(expect.objectContaining({ code: "TEXT.ROLE_INVALID" }));
  });

  it("does not use a heading outside the task's selected range", () => {
    const text = "Other Ingredients: Rice flour";
    const ingredient = item(text, "Rice flour");
    const input = anchoredInput(text, { range: { start: ingredient.start, end: text.length } });
    expect(() => assertIngredientRoles([ingredient], { input, text, nutrients: [] })).toThrow(
      expect.objectContaining({ code: "TEXT.ROLE_INVALID" }),
    );
  });

  it.each(["Herbal Blend", "Mineral Complex", "Botanical Matrix"])(
    "accepts a component below its %s",
    (name) => {
      const text = `${name}\nGinger`;
      const component = item(text, "Ginger", { role: "blend_component", parentNutrientIndex: 0 });
      const nutrients = [{ name: quoteAt(text, name) }];
      expect(() =>
        assertIngredientRoles([component], { input: anchoredInput(text), text, nutrients }),
      ).not.toThrow();
    },
  );

  it.each([
    ["Vitamin C\nGinger", ["Vitamin C"], 0],
    ["Herbal Blend\nGinger", ["Herbal Blend"], null],
    ["Herbal Blend\nGinger", ["Herbal Blend"], 5],
    ["Ginger\nHerbal Blend", ["Herbal Blend"], 0],
    ["Herbal Blend\nOther Ingredients: Ginger", ["Herbal Blend"], 0],
    ["Herbal Blend\nVitamin C\nGinger", ["Herbal Blend", "Vitamin C"], 0],
  ] as const)(
    "refuses a component without its own immediate blend: %s",
    (text, names, parentNutrientIndex) => {
      const component = item(text, "Ginger", { role: "blend_component", parentNutrientIndex });
      const nutrients = names.map((name) => ({ name: quoteAt(text, name) }));
      expect(() =>
        assertIngredientRoles([component], { input: anchoredInput(text), text, nutrients }),
      ).toThrow(expect.objectContaining({ code: "TEXT.ROLE_INVALID" }));
    },
  );
});

describe("assertIngredientBoundaries", () => {
  it("checks printed order regardless of array order and allows top-level comma or semicolon separators", () => {
    const text = "Rice flour, cellulose; silica";
    const items = ["silica", "Rice flour", "cellulose"].map((value) => item(text, value));
    expect(() => assertIngredientBoundaries(items, text)).not.toThrow();
    expect(items.map((entry) => entry.text)).toEqual(["silica", "Rice flour", "cellulose"]);
  });

  it("allows commas inside a parenthetical ingredient", () => {
    const text = "capsule (gelatin, water)";
    expect(() => assertIngredientBoundaries([item(text, text)], text)).not.toThrow();
  });

  it.each(["Rice flour, cellulose", "Rice flour; cellulose"])(
    "refuses multiple top-level ingredients in one quote: %s",
    (text) => {
      expect(() => assertIngredientBoundaries([item(text, text)], text)).toThrow(
        expect.objectContaining({ code: "TEXT.INGREDIENT_BOUNDARY" }),
      );
    },
  );

  it("refuses a line wrap split into sibling ingredients", () => {
    const text = "apple\ncider vinegar";
    expect(() =>
      assertIngredientBoundaries([item(text, "apple"), item(text, "cider vinegar")], text),
    ).toThrow(expect.objectContaining({ code: "TEXT.INGREDIENT_BOUNDARY" }));
  });

  it("refuses overlapping quotes, including exact duplicates", () => {
    const text = "Rice flour";
    expect(() => assertIngredientBoundaries([item(text, text), item(text, "flour")], text)).toThrow(
      expect.objectContaining({ code: "TEXT.INGREDIENT_BOUNDARY" }),
    );
    expect(() => assertIngredientBoundaries([item(text, text), item(text, text)], text)).toThrow(
      expect.objectContaining({ code: "TEXT.INGREDIENT_BOUNDARY" }),
    );
  });

  it("allows whitespace between components belonging to different parent lists", () => {
    const text = "Ginger\nTurmeric";
    const items = [
      item(text, "Ginger", { role: "blend_component", parentNutrientIndex: 0 }),
      item(text, "Turmeric", { role: "blend_component", parentNutrientIndex: 1 }),
    ];
    expect(() => assertIngredientBoundaries(items, text)).not.toThrow();
  });

  // The regex strips only innermost parentheses, then mistakes an enclosing-list comma for a top-level separator.
  it.fails("keeps nested parenthetical subingredients inside a single ingredient", () => {
    const text = "extract (leaf (dry), root)";
    expect(() => assertIngredientBoundaries([item(text, text)], text)).not.toThrow();
  });
});
