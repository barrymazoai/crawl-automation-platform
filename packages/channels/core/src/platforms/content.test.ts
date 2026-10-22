import { expect, it } from "vitest";
import { labelRange } from "../label-range.js";
import { completeFacts } from "./content.js";

// Kate Farms Pediatric Peptide 1.0 (retained page, 2026-10-22): no Serving Size is printed in this tab.
const medicalTable = `<section><h3>Nutrition Info</h3><table>
  <tr><th>Composition</th><th>Amount</th></tr>
  <tr><td>Calories</td><td>250kcal</td></tr>
  <tr><td>Sodium</td><td>160mg</td></tr>
  <tr><td>Protein</td><td>9g</td></tr></table></section>`;

it("marks a quantified medical nutrition table complete with its own Ingredients declaration", () => {
  const facts = completeFacts(
    `${medicalTable}<p>Ingredients: Purified Water, Brown Rice Syrup Solids.</p>`,
  );
  expect(facts.complete).toBe(true);
  expect(facts.missing).toEqual([]);
  expect(facts.text).toContain("Calories\t250kcal");
  expect(facts.text).not.toMatch(/Serving Size/i);
  expect(completeFacts(medicalTable).complete).toBe(false);
});

it("bounds Nutrition Info at the following Ingredients paragraph", () => {
  const text = [
    "Marketing summary",
    "Nutrition Info",
    "Composition\tAmount",
    "Calories\t250kcal",
    "Sodium\t160mg",
    "Protein\t9g",
    "Ingredients: Purified Water, Brown Rice Syrup Solids.",
    "Certifications",
    "USDA Organic",
  ].join("\n");
  const range = labelRange(text);
  expect(range).not.toBeNull();
  if (!range) {
    throw new Error("expected the nutrition panel to have a bounded range");
  }
  expect(text.slice(range.start, range.end)).toBe(
    "Nutrition Info\nComposition\tAmount\nCalories\t250kcal\nSodium\t160mg\nProtein\t9g\nIngredients: Purified Water, Brown Rice Syrup Solids.",
  );
});
