import { describe, expect, it } from "vitest";
import { LabelTextWireSchema } from "@crawl-automation/v3-contracts";
import { simpleLabel, decodeSimple } from "../../testing/simple-label.js";
import { decodeDrug, drugLines, drugWire } from "../../testing/drug-label-fixture.js";
import { decodeLabelText } from "./label-decoder.js";

// bloodsugarfriendly.com protein bar, 2026-10-21: the FDA Added Sugars wording, with the amount before its name.
const addedSugarsLines = [
  "Nutrition Facts",
  "Serving size 1 bar (60 g)",
  "Total Sugars 0 g, including 0 g Added Sugars (0% DV)",
  "Ingredients",
  "Milk Protein Concentrate, Allulose.",
];
const addedSugarsWire = () => {
  const anchor = (line: number, text: string) => ({ fromLine: line, toLine: line, text });
  const row = (name: string, amount: string, dailyValue: string | null) => ({
    kind: "nutrient",
    name: anchor(3, name),
    amount: anchor(3, amount),
    dailyValue: dailyValue ? anchor(3, dailyValue) : null,
    purpose: null,
    amountStatus: "printed",
    parentRowIndex: null,
  });
  return LabelTextWireSchema.parse({
    codec: "label-extraction/1",
    formula: {
      drugFacts: null,
      servingSize: anchor(2, "1 bar (60 g)"),
      servingsPerContainer: null,
      columns: [
        {
          heading: anchor(1, "Nutrition Facts"),
          rows: [row("Total Sugars", "0 g", null), row("Added Sugars", "0 g", "(0% DV)")],
        },
      ],
    },
    otherIngredients: {
      heading: anchor(4, "Ingredients"),
      items: [anchor(5, "Milk Protein Concentrate"), anchor(5, "Allulose")],
    },
    formulaComplete: true,
    ingredientsComplete: true,
    exclusions: [{ quote: anchor(2, "Serving size"), reason: "heading" }],
    issues: [],
  });
};

describe("derived structural coverage", () => {
  it("places an Added Sugars amount printed before its name and covers the row connector", () => {
    const text = addedSugarsLines.join("\n");
    const result = decodeLabelText({
      text,
      scope: { range: { start: 0, end: text.length } },
      response: JSON.stringify(addedSugarsWire()),
      policyVersion: "label-text/6",
    });
    expect(result.codes).toEqual([]);
    const rows = result.candidate.formula?.columns[0]?.rows ?? [];
    expect(rows.map((row) => row.amount?.start)).toEqual([
      text.indexOf("0 g,"),
      text.indexOf("0 g Added"),
    ]);
  });
  it.each(["Supplement Facts", "Nutrition Facts"])(
    "covers %s and value-anchored structures",
    (heading) => {
      expect(decodeSimple(simpleLabel({ heading })).codes).toEqual([]);
    },
  );
  it.each(["Zinc 5 mg", "Extra herb", "200 mg"])("still requires data %s", (missing) => {
    const fixture = simpleLabel();
    fixture.lines.push(missing);
    expect(decodeSimple(fixture).codes).toContain("LABEL.EXTRACTION_INCOMPLETE");
  });
  it("does not cover a serving value or another panel merely because a heading exists", () => {
    const fixture = simpleLabel();
    if (fixture.wire.formula) {
      fixture.wire.formula.servingsPerContainer = null;
    }
    expect(decodeSimple(fixture).codes).toContain("LABEL.EXTRACTION_INCOMPLETE");
    const second = simpleLabel();
    second.lines.push("Nutrition Facts");
    expect(decodeSimple(second).codes).toContain("LABEL.EXTRACTION_INCOMPLETE");
  });
  it("keeps Drug Facts strengths, Purpose and cited directions without inventing servings", () => {
    const lines = drugLines.map((line) => line.replace("lactose, sucrose", "lactose, and sucrose"));
    const result = decodeDrug(drugWire(), lines);
    expect(result.codes).toEqual([]);
    expect(result.candidate.formula?.servingSize).toBeNull();
    expect(result.candidate.formula?.columns[0]?.rows[0]?.amount?.text).toBe("30C HPUS");
    expect(decodeDrug(drugWire(), [...lines, "Belladonna 6X HPUS"]).codes).toContain(
      "LABEL.EXTRACTION_INCOMPLETE",
    );
  });
});
