import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";

export const agreementField = (text: string) => ({ text, evidence: text });

/** The reported Prevagen shape: Vitamin D 50 mcg, Apoaequorin 10 mg, one ingredients list. */
export function agreementCandidate(
  vitamin = "Vitamin D (as cholecalciferol)",
  ingredients = ["Microcrystalline cellulose", "casein peptones"],
): LabelImageCandidate {
  const nutrient = (name: string, amount: string, dailyValue: string | null) => ({
    kind: "nutrient" as const,
    name: agreementField(name),
    amount: agreementField(amount),
    amountStatus: "printed" as const,
    dailyValue: dailyValue === null ? null : agreementField(dailyValue),
    parentRowIndex: null,
  });
  return {
    codec: "label-extraction/1",
    formula: {
      servingSize: agreementField("1 Capsule"),
      servingsPerContainer: agreementField("30"),
      columns: [
        {
          heading: agreementField("Amount Per Serving"),
          rows: [nutrient(vitamin, "50 mcg", "250%"), nutrient("Apoaequorin", "10 mg", null)],
        },
      ],
    },
    otherIngredients: {
      heading: agreementField("Other Ingredients"),
      items: ingredients.map(agreementField),
    },
    formulaComplete: true,
    ingredientsComplete: true,
    exclusions: [],
    issues: [],
  };
}
