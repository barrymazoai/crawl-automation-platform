import { LabelTextWireSchema } from "@crawl-automation/v3-contracts";
import { decodeLabelText } from "../text/protocol/label-decoder.js";

/** Small, handwritten evidence based on the saved Boiron panels; never a saved page or model result. */
export const drugLines = [
  "Drug Facts",
  "Active ingredient (in each tablet)",
  "Active ingredient Purpose",
  "Arnica montana 30C HPUS Relieves muscle pain",
  "**C, K, CK, and X are homeopathic dilutions.",
  "Uses: temporarily relieves muscle pain",
  "Warnings",
  "Keep out of reach of children.",
  "Directions: dissolve pellets",
  "Other information: store at room temperature",
  "Inactive Ingredients: lactose, sucrose",
  "Questions: Call the manufacturer",
];
const anchor = (line: number, text = drugLines[line - 1] ?? "") => ({
  fromLine: line,
  toLine: line,
  text,
});

export function drugWire() {
  return LabelTextWireSchema.parse({
    codec: "label-extraction/1",
    formula: {
      drugFacts: anchor(1),
      servingSize: null,
      servingsPerContainer: null,
      columns: [
        {
          heading: anchor(2),
          rows: [
            {
              kind: "nutrient",
              name: anchor(4, "Arnica montana"),
              amount: anchor(4, "30C HPUS"),
              purpose: anchor(4, "Relieves muscle pain"),
              dailyValue: null,
              amountStatus: "printed",
              parentRowIndex: null,
            },
          ],
        },
      ],
    },
    otherIngredients: {
      heading: anchor(11, "Inactive Ingredients:"),
      items: [anchor(11, "lactose"), anchor(11, "sucrose")],
    },
    formulaComplete: true,
    ingredientsComplete: true,
    issues: [],
    exclusions: drugExclusions(),
  });
}

export function decodeDrug(wire = drugWire(), lines = drugLines) {
  const text = lines.join("\n");
  return decodeLabelText({
    text,
    response: JSON.stringify(wire),
    policyVersion: "label-text/5",
    scope: { range: { start: 0, end: text.length } },
  });
}

function drugExclusions() {
  return [
    { quote: anchor(3), reason: "heading" },
    { quote: anchor(5), reason: "footnote" },
    {
      quote: { fromLine: 7, toLine: 8, text: drugLines.slice(6, 8).join("\n") },
      reason: "directions",
    },
    ...[6, 9, 10, 12].map((line) => ({ quote: anchor(line), reason: "directions" })),
  ];
}
