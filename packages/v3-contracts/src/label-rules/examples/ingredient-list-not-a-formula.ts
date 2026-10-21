import type { LabelImageCandidate } from "../../label-extraction.js";
import type { LabelRuleExamples } from "../index.js";
import { column } from "./rows.js";

const field = (text: string) => ({ text, evidence: text });
function ingredientOnly(name: string, ingredients: string[]): LabelImageCandidate {
  return {
    codec: "label-extraction/1",
    formula: { drugFacts: null, servingSize: null, servingsPerContainer: null, columns: [{ heading: null, rows: column([["nutrient", null, name]]) }] },
    otherIngredients: { heading: field("Ingredients"), items: ingredients.map(field) },
    formulaComplete: false, ingredientsComplete: true, exclusions: [], issues: [],
  };
}

export const ingredientListNotAFormulaExamples: LabelRuleExamples<LabelImageCandidate> = {
  pass: [
    { subject: ingredientOnly("Ingredients", ["Organic Sunflower (Helianthus Annuus) Seed Oil", "Organic Beeswax (Cera Alba)", "Organic Coconut (Cocos Nucifera) Oil"]), source: "B078B9JPLX text-efd1cd1a Ingredients row and Ingredients list" },
    { subject: ingredientOnly("Sodium Palmate", ["Sodium Palmate", "Sodium Cocoate/Sodium Palm Kernelate", "Water (Aqua)", "Glycerin"]), source: "8572268707978 text-f7eaa8f1 Sodium Palmate repeats Ingredients list" },
  ],
  fail: [
    { subject: { ...ingredientOnly("Vitamin D3 (as Cholecalciferol)", ["Delayed-Release Vegetable Capsule (Hypromellose)", "Microcrystalline Cellulose"]), formula: { drugFacts: null, servingSize: null, servingsPerContainer: null, columns: [{ heading: field("Ingredients"), rows: column([["nutrient", null, "Vitamin D3 (as Cholecalciferol)"], ["nutrient", null, "Zinc (as Zinc Bisglycinate Chelate)"], ["blend_total", null, "Probiotic Blend", "50 Billion CFU‡"]]) }] }, otherIngredients: { heading: field("Other Ingredients:"), items: [field("Delayed-Release Vegetable Capsule (Hypromellose)"), field("Microcrystalline Cellulose")] }, formulaComplete: true }, source: "B0FK9284FC text-f242e65c has a printed Probiotic Blend amount and distinct Other Ingredients" },
    { subject: ingredientOnly("Vitamin B12 (as cyanocobalamin)", ["Vitamin B12 (as cyanocobalamin)", "Purified water", "Glycerin"]), source: "B0BN2KHKBT text-f4282aac: duplicated active supplement ingredient still needs dose review" },
  ],
};
