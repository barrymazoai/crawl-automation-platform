import { LabelTextWireSchema } from "@crawl-automation/v3-contracts";
import { expect, it } from "vitest";
import { decodeLabelText } from "./label-decoder.js";

it("keeps 'and' accepted between a blend total and its own components", () => {
  const names = [
    "N.O.V8™",
    "Fermented Lettuce Powder (Lactuca sativa) (leaf)",
    "Fermented Cabbage Powder (Brassica oleracea) (head)",
    "Fermented Garlic Powder (Allium sativum) (bulb)",
  ];
  const lines = ["1 Scoop", ...names.slice(0, 3), "and", names[3] ?? "", "20 mg"];
  const anchor = (fromLine: number) => ({ fromLine, toLine: fromLine, text: lines[fromLine - 1] });
  const wire = LabelTextWireSchema.parse({
    codec: "label-extraction/1",
    formula: {
      servingSize: anchor(1),
      servingsPerContainer: null,
      columns: [
        {
          heading: null,
          rows: [2, 3, 4, 6].map((line, index) => ({
            kind: index ? "blend_component" : "blend_total",
            name: anchor(line),
            amount: index ? null : anchor(7),
            dailyValue: null,
            amountStatus: index ? "not_declared" : "printed",
            parentRowIndex: index ? 0 : null,
          })),
        },
      ],
    },
    otherIngredients: null,
    formulaComplete: true,
    ingredientsComplete: true,
    exclusions: [{ reason: "noise", quote: anchor(5) }],
    issues: [],
  });
  const text = lines.join("\n");
  expect(
    decodeLabelText({
      text,
      response: JSON.stringify(wire),
      policyVersion: "label-text/5",
      scope: { range: { start: 0, end: text.length } },
    }).codes,
  ).toEqual([]);
});
