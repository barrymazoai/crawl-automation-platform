import type { LabelTextCandidate } from "../../label-extraction.js";
import type { IngredientParagraphSubject } from "../undosed-ingredient-paragraph.js";
import type { LabelRuleExamples } from "../rule.js";

function paragraph(names: string[], withList = true): IngredientParagraphSubject {
  const text = `Ingredients\n\n${names.join(",")}`;
  let after = 13;
  const items = names.map((name) => {
    const start = text.indexOf(name, after);
    after = start + name.length;
    return { text: name, start, end: after };
  });
  const candidate: LabelTextCandidate = {
    codec: "label-extraction/1",
    formula: {
      drugFacts: null,
      servingSize: null,
      servingsPerContainer: null,
      columns: [
        {
          heading: null,
          rows: items.map((name) => ({
            kind: "nutrient",
            name,
            amount: null,
            dailyValue: null,
            purpose: null,
            amountStatus: "not_declared",
            parentRowIndex: null,
          })),
        },
      ],
    },
    otherIngredients: withList
      ? { heading: { text: "Ingredients", start: 0, end: 11 }, items }
      : null,
    formulaComplete: false,
    ingredientsComplete: withList,
    exclusions: [],
    issues: [],
  };
  return { candidate, text, range: { start: 0, end: text.length } };
}

const water = paragraph(["water", "tapioca dextrin", "vegetable oil"]);
const calcium = paragraph([
  "calcium carbonate",
  "calcium phosphate",
  "maltose",
  "natural flavors",
  "silicon dioxide",
  "starch",
  "vegetable magnesium stearate",
]);

export const undosedIngredientParagraphExamples: LabelRuleExamples<IngredientParagraphSubject> = {
  pass: [
    {
      subject: water,
      source: "text-fbea7a7e: stored Ingredients answer has three duplicated undosed formula rows",
    },
    {
      subject: calcium,
      source: "text-fe52455c: stored Ingredients answer has seven duplicated undosed formula rows",
    },
    {
      subject: paragraph(
        [
          "Hydrolyzed Bovine Collagen Peptides",
          "Bovine Bone Broth Hydrolyzed Protein",
          "Eggshell Membrane Collagen Amino Acids: Alanine",
          "Leucine",
        ],
        false,
      ),
      source:
        "constructed from B078SD9ZY5 page text, with the model items misclassified as formula rows",
    },
  ],
  fail: [
    {
      subject: { ...water, text: water.text.replace("Ingredients", "Supplement Facts") },
      source: "constructed panel-heading contrast from a stored Ingredients paragraph",
    },
    {
      subject: {
        ...water,
        candidate: {
          ...water.candidate,
          formula: {
            ...water.candidate.formula!,
            servingSize: { text: "1 scoop", start: 0, end: 7 },
          },
        },
      },
      source: "constructed serving-size contrast from a stored Ingredients paragraph",
    },
    {
      subject: {
        ...water,
        candidate: {
          ...water.candidate,
          formula: {
            ...water.candidate.formula!,
            columns: [
              {
                ...water.candidate.formula!.columns[0]!,
                rows: water.candidate.formula!.columns[0]!.rows.map((row, index) =>
                  index === 0
                    ? {
                        ...row,
                        amount: { text: "5 mg", start: 0, end: 4 },
                        amountStatus: "printed" as const,
                      }
                    : row,
                ),
              },
            ],
          },
        },
      },
      source: "constructed amount contrast from a stored Ingredients paragraph",
    },
  ],
};
