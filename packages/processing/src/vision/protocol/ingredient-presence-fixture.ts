import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";
import { retainIngredientPresenceAnswer } from "./label-ingredient-presence.js";

export const printed = (text: string) => ({ text, evidence: text });

/** Minimal synthetic regression from B08QDNPQPK's saved /1 answer; no artifacts or private IDs. */
export function savedOreganoLabel(): LabelImageCandidate {
  return {
    codec: "label-extraction/1",
    formula: {
      servingSize: { text: "2 drops", evidence: "Amount per serving: 2 drops" },
      servingsPerContainer: { text: "194", evidence: "Servings per container: 194" },
      columns: [
        {
          heading: printed("Amount per serving: 2 drops"),
          rows: [
            {
              kind: "blend_total",
              name: printed("Proprietary blend (2 drops)"),
              amount: printed("50 mg total weight in organic extra virgin olive oil"),
              dailyValue: null,
              amountStatus: "printed",
              parentRowIndex: null,
            },
            {
              kind: "blend_component",
              name: printed("Organic, wild Mediterranean oregano oil P73*"),
              amount: null,
              dailyValue: printed("*"),
              amountStatus: "not_declared",
              parentRowIndex: 0,
            },
          ],
        },
      ],
    },
    otherIngredients: null,
    formulaComplete: true,
    ingredientsComplete: false,
    exclusions: [],
    issues: [{ code: "INGREDIENTS_MISSING", detail: "No Other Ingredients section is visible." }],
  };
}

/** Hypothetical NEW observation, not a claim that the saved label was entirely visible. */
export function explicitNoneWire() {
  return {
    codec: "label-visual-wire/3" as const,
    label: { ...savedOreganoLabel(), ingredientsComplete: true, issues: [] } as LabelImageCandidate,
    otherIngredientsBlock: null as { text: string; evidence: string } | null,
    otherIngredientsState: "none_printed" as
      "none_printed" | "present" | "not_fully_visible" | "unreadable",
    wholeLabelVisible: true,
  };
}

export const savedPresenceAnswer = (wire = explicitNoneWire(), allow = true) =>
  retainIngredientPresenceAnswer(JSON.stringify(wire), { allowNoOtherIngredientsSection: allow });
