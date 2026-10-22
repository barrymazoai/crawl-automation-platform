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
  it("reads a bracketed minor-ingredient group spelled 'percent' (Natrol gummies, 2026-10-21)", () => {
    const items = ["Water", "Citric Acid", "Pectin"];
    const ingredients = "Water, Contains 2 percent or less of (Citric Acid, Pectin).";
    expect(decodeSimple(simpleLabel({ items, ingredients })).codes).toEqual([]);
  });
  it("reads Kate Farms' inline 1.5% minor heading and a named blend with its components (2026-10-22)", () => {
    const items = [
      "Sunflower Lecithin*",
      "Spectra™ Phytonutrient Blend*: Extracts and Concentrates from: Broccoli*",
      "CoffeeBerry®*",
    ];
    const ingredients =
      "Sunflower Lecithin*, Contains 1.5% or Less of: Spectra™ Phytonutrient Blend*: Extracts and Concentrates from: Broccoli*, CoffeeBerry®*";
    expect(decodeSimple(simpleLabel({ items, ingredients })).codes).toEqual([]);
    const words = ["Sunflower Lecithin*", "Vanilla Extract*"];
    expect(
      decodeSimple(
        simpleLabel({
          items: words,
          ingredients: "Sunflower Lecithin*, Directions: shake well. Vanilla Extract*",
        }),
      ).codes,
    ).not.toEqual([]);
  });
  it("keeps the Peptide 1.5 blend sublist, parenthesized blend and organic legend (2026-10-22)", () => {
    const ingredients =
      "Purified Water, Hydrolyzed Pea Protein*, Brown Rice Syrup Solids*, Agave Syrup*, High Linoleic Sunflower Oil*, Medium Chain Triglycerides (MCT from Coconut)*, Contains 1.5% or Less of: Vanilla Extract*, Natural Flavor*, Agave Inulin*, Flaxseed Oil*, Pea Starch*, Locust Bean Gum*, Rosemary Extract*, Sunflower Lecithin*, Spectra™ Phytonutrient Blend*: Extracts and Concentrates from: Broccoli*, CoffeeBerry®*, Green Tea*, Turmeric*, Kale*, Broccoli Sprout*, Acai*, Cinnamon*, Garlic*, Tomato*, Blueberry*, Carrot*, Beet*, Raspberry*, Spinach*, Tart Cherry*, Blackberry*,\u00a0Vitamin and Mineral Blend:\u00a0(Choline Bitartrate, Magnesium Chloride, Sodium Chloride, Tricalcium Phosphate, Sodium Ascorbate, Calcium Carbonate, Dimagnesium Phosphate, Potassium Chloride, Dipotassium Phosphate, DL-Alpha-Tocopheryl Acetate, Beta Carotene, Calcium Pantothenate, Cholecalciferol [Vitamin D3], Ferric Pyrophosphate, Niacinamide, Sodium Molybdate, Vitamin A Palmitate, Zinc Oxide, Biotin, Chromium Picolinate, Copper Sulfate, Cyanocobalamin [Vitamin B12], Folic Acid, Manganese Sulfate, Phylloquinone, Potassium Iodide, Pyridoxine Hydrochloride, Riboflavin, Sodium Selenite, Thiamine Hydrochloride), L-Cysteine, L-Carnitine, Taurine, L-Tryptophan. *Organic";
    const items = [
      "Purified Water",
      "Hydrolyzed Pea Protein*",
      "Brown Rice Syrup Solids*",
      "Agave Syrup*",
      "High Linoleic Sunflower Oil*",
      "Medium Chain Triglycerides (MCT from Coconut)*",
      "Vanilla Extract*",
      "Natural Flavor*",
      "Agave Inulin*",
      "Flaxseed Oil*",
      "Pea Starch*",
      "Locust Bean Gum*",
      "Rosemary Extract*",
      "Sunflower Lecithin*",
      "Spectra™ Phytonutrient Blend*: Extracts and Concentrates from:",
      "Broccoli*",
      "CoffeeBerry®*",
      "Green Tea*",
      "Turmeric*",
      "Kale*",
      "Broccoli Sprout*",
      "Acai*",
      "Cinnamon*",
      "Garlic*",
      "Tomato*",
      "Blueberry*",
      "Carrot*",
      "Beet*",
      "Raspberry*",
      "Spinach*",
      "Tart Cherry*",
      "Blackberry*",
      "Vitamin and Mineral Blend: (Choline Bitartrate, Magnesium Chloride, Sodium Chloride, Tricalcium Phosphate, Sodium Ascorbate, Calcium Carbonate, Dimagnesium Phosphate, Potassium Chloride, Dipotassium Phosphate, DL-Alpha-Tocopheryl Acetate, Beta Carotene, Calcium Pantothenate, Cholecalciferol [Vitamin D3], Ferric Pyrophosphate, Niacinamide, Sodium Molybdate, Vitamin A Palmitate, Zinc Oxide, Biotin, Chromium Picolinate, Copper Sulfate, Cyanocobalamin [Vitamin B12], Folic Acid, Manganese Sulfate, Phylloquinone, Potassium Iodide, Pyridoxine Hydrochloride, Riboflavin, Sodium Selenite, Thiamine Hydrochloride)",
      "L-Cysteine",
      "L-Carnitine",
      "Taurine",
      "L-Tryptophan",
    ];
    const fixture = simpleLabel({ ingredients, items });
    fixture.lines[6] = `Ingredients:\u00a0${ingredients}`;
    defined(fixture.wire.otherIngredients).heading.text = "Ingredients:";
    fixture.wire.exclusions.push(
      { quote: { fromLine: 7, toLine: 7, text: "Contains 1.5% or Less of:" }, reason: "heading" },
      { quote: { fromLine: 7, toLine: 7, text: "*Organic" }, reason: "footnote" },
    );
    expect(decodeSimple(fixture).codes).toEqual([]);

    // Fresh Peptide 1.5 answer: the blend heading and first component share one item;
    // the same trailing marker legend is classified as noise instead of footnote.
    const freshItems = [...items];
    freshItems.splice(
      14,
      2,
      "Spectra™ Phytonutrient Blend*: Extracts and Concentrates from: Broccoli*",
    );
    const fresh = simpleLabel({ ingredients, items: freshItems });
    fresh.lines[6] = `Ingredients:\u00a0${ingredients}`;
    defined(fresh.wire.otherIngredients).heading.text = "Ingredients:";
    fresh.wire.exclusions.push(
      { quote: { fromLine: 7, toLine: 7, text: "Contains 1.5% or Less of:" }, reason: "heading" },
      { quote: { fromLine: 7, toLine: 7, text: "*Organic" }, reason: "noise" },
    );
    expect(decodeSimple(fresh).codes).toEqual([]);

    const unsupportedLegend = simpleLabel({
      ingredients: "Purified Water. *Organic",
      items: ["Purified Water"],
    });
    unsupportedLegend.wire.exclusions.push({
      quote: { fromLine: 7, toLine: 7, text: "*Organic" },
      reason: "noise",
    });
    expect(decodeSimple(unsupportedLegend).codes).toContain("LABEL.COVERAGE_UNCERTAIN");

    // Real Standard 1.4 span: four printed ingredients cannot disappear between anchored items.
    expect(
      decodeSimple(
        simpleLabel({
          ingredients:
            "Beet*, Raspberry*, Spinach*, Tart Cherry*, Blackberry*, Vitamin and Mineral Blend: (Choline Bitartrate, Magnesium Chloride)",
          items: ["Beet*", "Vitamin and Mineral Blend: (Choline Bitartrate, Magnesium Chloride)"],
        }),
      ).codes,
    ).toContain("LABEL.INGREDIENT_BOUNDARY");

    // Real Pediatric Peptide 1.5 span: the named blend cannot be discarded as a heading.
    const omittedBlend = simpleLabel({
      ingredients:
        "Sunflower Lecithin*, Spectra™ Phytonutrient Blend*: Extracts and Concentrates from: Broccoli*, CoffeeBerry®*",
      items: ["Sunflower Lecithin*", "Broccoli*", "CoffeeBerry®*"],
    });
    omittedBlend.wire.exclusions.push(
      {
        quote: { fromLine: 7, toLine: 7, text: "Spectra™ Phytonutrient Blend*:" },
        reason: "heading",
      },
      {
        quote: { fromLine: 7, toLine: 7, text: "Extracts and Concentrates from:" },
        reason: "heading",
      },
    );
    expect(decodeSimple(omittedBlend).codes).toContain("LABEL.INGREDIENT_BOUNDARY");

    const invalid = simpleLabel({
      ingredients: "Spectra™ Phytonutrient Blend*: Directions: Broccoli*",
      items: ["Spectra™ Phytonutrient Blend*: Directions:", "Broccoli*"],
    });
    expect(decodeSimple(invalid).codes).toContain("LABEL.INGREDIENT_BOUNDARY");
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
  it("accepts a cited title-case sublist heading after a sentence delimiter", () => {
    const text = "Collagen. Amino Acids: Alanine, Arginine";
    const collagen = { text: "Collagen", start: 0, end: 8 };
    const alanine = { text: "Alanine", start: 23, end: 30 };
    const heading = { text: "Amino Acids:", start: 10, end: 22 };
    expect(ingredientGap(text, collagen, alanine)).toBeNull();
    expect(ingredientGap(text, collagen, { next: alanine, headings: [heading] })).toEqual({
      start: 8,
      end: 23,
    });
    expect(
      ingredientGap("Collagen. Directions: Alanine", collagen, {
        next: { text: "Alanine", start: 22, end: 29 },
        headings: [{ text: "Directions:", start: 10, end: 21 }],
      }),
    ).toBeNull();
    for (const heading of ["Contains Milk:", "Manufactured In A Facility:"]) {
      const source = `Collagen. ${heading} Alanine`;
      const start = source.indexOf(heading);
      const nextStart = source.indexOf("Alanine");
      expect(
        ingredientGap(source, collagen, {
          next: { text: "Alanine", start: nextStart, end: source.length },
          headings: [{ text: heading, start, end: start + heading.length }],
        }),
      ).toBeNull();
    }
  });
  it("keeps a numeric chemical locant within one ingredient", () => {
    expect(completeIngredientItem("cyclohexane 1,4-dicarboxylate")).toBe(true);
    expect(completeIngredientItem("Vitamin B12, 4-dicarboxylate")).toBe(false);
  });
  it("keeps comma-separated quality modifiers but rejects a merged ingredient", () => {
    expect(completeIngredientItem("Wild, high-mountain, organic sage oil powder")).toBe(true);
    expect(completeIngredientItem("Wild, Zinc Oxide, organic sage oil powder")).toBe(false);
  });
  it("keeps a cited amino-acid sublist segmented into individual entries", () => {
    const fixture = simpleLabel({
      ingredients: "Bovine Collagen Peptides. Amino Acids: Alanine, Arginine",
      items: ["Bovine Collagen Peptides", "Alanine", "Arginine"],
    });
    fixture.wire.exclusions.push({
      quote: { fromLine: 7, toLine: 7, text: "Amino Acids:" },
      reason: "heading",
    });
    expect(decodeSimple(fixture).codes).not.toContain("LABEL.INGREDIENT_BOUNDARY");
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
