import { LabelTextWireSchema, LabelImageCandidateSchema } from "@crawl-automation/v3-contracts";
import { decodeLabelText } from "../text/protocol/label-decoder.js";

const anchor = (line: number, text: string) => ({ fromLine: line, toLine: line, text });

/** Short synthetic label; fields quote only values, leaving structural coverage to the decoder. */
export function simpleLabel(
  options: {
    heading?: string;
    ingredients?: string;
    items?: string[];
    note?: string;
  } = {},
) {
  const items = options.items ?? ["Cellulose", "Silica"];
  const lines = [
    options.heading ?? "Supplement Facts",
    "Serving Size: 1 capsule",
    "Servings Per Container: 30",
    "Amount Per Serving % Daily Value",
    "Vitamin C 60 mg 67%",
    "† Daily Value not established.",
    `Other Ingredients: ${options.ingredients ?? items.join(", and ")}`,
    options.note ?? "",
  ];
  const wire = LabelTextWireSchema.parse({
    codec: "label-extraction/1",
    formula: simpleFormula(),
    otherIngredients: {
      heading: anchor(7, "Other Ingredients:"),
      items: items.map((item) => anchor(7, item)),
    },
    formulaComplete: true,
    ingredientsComplete: true,
    exclusions: [],
    issues: [],
  });
  return { lines, wire };
}

export function decodeSimple(fixture: ReturnType<typeof simpleLabel>) {
  const text = fixture.lines.join("\n");
  return decodeLabelText({
    text,
    scope: { range: { start: 0, end: text.length } },
    response: JSON.stringify(fixture.wire),
    policyVersion: "label-text/5",
  });
}

/** The same handwritten fields represented as an image transcription. */
export function simpleImage(wire = simpleLabel().wire) {
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(convert);
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    if ("fromLine" in value && "text" in value) {
      return { text: value.text, evidence: value.text };
    }
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, convert(field)]));
  };
  return LabelImageCandidateSchema.parse(convert(wire));
}

function simpleFormula() {
  return {
    servingSize: anchor(2, "1 capsule"),
    servingsPerContainer: anchor(3, "30"),
    columns: [
      {
        heading: anchor(4, "Amount Per Serving % Daily Value"),
        rows: [
          {
            kind: "nutrient",
            name: anchor(5, "Vitamin C"),
            amount: anchor(5, "60 mg"),
            dailyValue: anchor(5, "67%"),
            amountStatus: "printed",
            parentRowIndex: null,
          },
        ],
      },
    ],
  };
}
