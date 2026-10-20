import { expect, it } from "vitest";
import { labelRange } from "./label-range.js";

const panel = (fat: string, protein = "20g 40%", serving = "60g") =>
  [
    "Nutrition Facts",
    `Serving size 1 Bar (${serving})`,
    `Total Fat ${fat} 10%`,
    `Protein ${protein}`,
    "*The % Daily Value (DV) tells you how much a nutrient contributes.",
  ].join("\n");
const ingredients = "INGREDIENTS: Milk Protein, Allulose.\nCONTAINS: MILK.";
const covered = (text: string) => {
  const range = labelRange(text);
  return range ? text.slice(range.start, range.end) : null;
};

it("takes the repeated panel that carries the ingredients, and only that", () => {
  const label = `${panel("8g")}\n\n${ingredients}`;
  const text = [
    "Home / Shop",
    panel("8g"),
    "Marketing about sugar, 0 g net carbs.",
    label,
    "FAQ",
  ].join("\n\n");
  expect(covered(text)).toBe(label);
});

it("keeps the whole page when panels list different amounts", () => {
  const text = [
    panel("8g"),
    ingredients,
    panel("16g", "40g 80%", "120g"),
    "INGREDIENTS: Whey.",
  ].join("\n\n");
  expect(labelRange(text)).toBeNull();
});

it("keeps the whole page when the ingredients are not after the panel", () => {
  expect(labelRange(["INGREDIENTS: Whey.", "Lots of text", panel("8g")].join("\n\n"))).toBeNull();
});

it("keeps the whole page without a panel", () => {
  expect(labelRange("Home\n\nINGREDIENTS: Whey.")).toBeNull();
});

it("keeps the whole page when the panel's end is unknown (Drug Facts, a sentence)", () => {
  const drug = [
    "Drug Facts",
    "Active ingredient Purpose",
    "Menthol 0.1% Cold sore treatment",
    "Uses",
  ];
  expect(labelRange(drug.join("\n"))).toBeNull();
  expect(
    labelRange("Supplement facts - Serving size: 1 scoop - Transparent label.\n\nMore text"),
  ).toBeNull();
});

it("ends the panel at its footnote, not at a column heading or a later Daily Value sentence", () => {
  const label = [
    "Nutrition Facts",
    "Melatonin, 5 mg",
    "Amount Per Serving",
    "%DV",
    "Vitamin B6 10mg 588%",
    "Melatonin 5mg",
    "*",
    "Other Ingredients",
    "Microcrystalline Cellulose, Stearic Acid.",
  ].join("\n");
  const text = [
    label,
    "Suggested Use",
    "Take 1 tablet.",
    "FAQ: 20 g is 40% of the Daily Value.",
  ].join("\n");
  expect(covered(text)).toBe(label);
});
