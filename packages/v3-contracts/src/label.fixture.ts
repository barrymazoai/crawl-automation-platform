import type { LabelImageCandidate } from "./label-extraction.js";
/** Hand-transcribed structural fixture inspired by GNC 613701; NOT a model result/receipt. */
export function gncLabelFixture(): LabelImageCandidate {
  const f = (text: string) => ({ text, evidence: text });
  const row = (kind: "nutrient" | "group_header" | "blend_component", name: string, amount: string | null, parentRowIndex: number | null = null) =>
    ({ kind, name: f(name), amount: amount ? f(amount) : null, dailyValue: null,
      amountStatus: amount ? "printed" as const : "not_applicable" as const, parentRowIndex });
  return { codec: "label-extraction/1", formula: { servingSize: f("2"), servingsPerContainer: f("3"), columns: [{ heading: f("Amounts Per Serving"), rows: [
    row("nutrient", "Calories", "12"), row("nutrient", "Total Carbohydrates", "4 g"),
    row("nutrient", "Total Sugars", "2 g"), row("nutrient", "Added Sugars", "2 g"),
    row("group_header", "FocusFuel™ Electrolyte Blend", null),
    row("blend_component", "Sodium", "200 mg", 4), row("blend_component", "Potassium", "100 mg", 4),
    row("blend_component", "Magnesium", "50 mg", 4), row("blend_component", "Watermelon Juice Powder", "200 mg", 4),
    row("group_header", "FocusFuel™ Focus Blend", null),
    row("blend_component", "Alpha GPC", "200 mg", 9), row("blend_component", "Lion’s Mane", "200 mg", 9),
    row("blend_component", "Ashwagandha", "200 mg", 9),
    row("group_header", "FocusFuel™ Electrolyte Blend", null),
    row("blend_component", "Natural Caffeine (from Guarana seed and green tea blend)", "100 mg", 13),
    row("blend_component", "L-Theanine", "100 mg", 13), row("blend_component", "Black Pepper/BioPerine", "5 mg", 13),
    row("blend_component", "Vitamin B12 (Methylcobalamin)", "2.4 mcg", 13),
  ] }] }, otherIngredients: { heading: f("Other Ingredients"), items: ["Malt Syrup", "Organic Cane Sugar", "Pectin", "Sodium Citrate", "Citric Acid", "Lactic Acid", "Natural Flavor Juice"].map(f) },
  formulaComplete: true, ingredientsComplete: true, exclusions: [], issues: [] };
}
