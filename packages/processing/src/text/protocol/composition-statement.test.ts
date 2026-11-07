import { describe, expect, it } from "vitest";
import { assessLabelCandidate } from "@crawl-automation/v3-contracts";
import { decodeLabelText } from "./label-decoder.js";

/**
 * Owner 2026-11-07 (amazon.in, KAN-243): an Indian page's ingredients statement is often a dosed composition
 * ("Ingredients: Each 10 g contains: Isabgol 10 g"). Answers copied from the stored Reviews.
 */
const row = (name: string, amount: string | null) => ({
  kind: amount ? "nutrient" : "group_header",
  name: { fromLine: 3, toLine: 3, text: name },
  amount: amount ? { fromLine: 3, toLine: 3, text: amount } : null,
  dailyValue: null,
  purpose: null,
  amountStatus: amount ? "printed" : "not_applicable",
  parentRowIndex: null,
});

function answer(rows: ReturnType<typeof row>[][], exclusions: string[] = [], serving?: string) {
  return JSON.stringify({
    codec: "label-extraction/1",
    formula: {
      drugFacts: null,
      servingSize: serving ? { fromLine: 3, toLine: 3, text: serving } : null,
      servingsPerContainer: null,
      columns: rows.map((columnRows, index) => ({
        heading: index
          ? { fromLine: 3, toLine: 3, text: columnRows[0]?.name.text ?? "" }
          : { fromLine: 1, toLine: 1, text: "Ingredients:" },
        rows: columnRows,
      })),
    },
    otherIngredients: null,
    formulaComplete: true,
    ingredientsComplete: true,
    exclusions: exclusions.map((text) => ({
      quote: { fromLine: 3, toLine: 3, text },
      reason: "heading",
    })),
    issues: [],
  });
}

const decode = (text: string, response: string) =>
  decodeLabelText({
    scope: { range: { start: 0, end: text.length } },
    text,
    response,
    policyVersion: "label-text/6",
  });

describe("an ingredients statement that is a dosed composition", () => {
  it("keeps the composition as the formula; 'complete' with no separate list is not a contradiction", () => {
    const text = "Ingredients:\n\nEach 10 g contains: Isabgol (Plantago ovata, Sd. Husk) 10 g";
    const decoded = decode(
      text,
      answer(
        [[row("Isabgol (Plantago ovata, Sd. Husk)", "10 g")]],
        ["Each 10 g contains:"],
        "10 g",
      ),
    );

    expect(decoded.codes).toEqual([]);
    expect(decoded.candidate.formula?.columns[0]?.rows.map((read) => read.amount?.text)).toEqual([
      "10 g",
    ]);
    expect(decoded.candidate.otherIngredients).toBeNull();
    // The merge checks the stored answer again with the shared rules (Dabur Isabgol, rerun 2026-11-07).
    expect(decoded.candidate.ingredientsComplete).toBe(false);
    expect(assessLabelCandidate(decoded.candidate).codes).toEqual([]);
  });

  it("stays in Review when the composition heading itself was read as a row (Krishna's)", () => {
    const heading = "Each 100 ml Juice/Swaras contains:";
    const text = `Ingredients:\n\n${heading} Shunthi (Zingiber officinale) Rz. - 15 ml`;
    const decoded = decode(
      text,
      answer([[row("Shunthi (Zingiber officinale) Rz.", "15 ml")], [row(heading, null)]]),
    );

    expect(decoded.status).toBe("review");
    expect(decoded.codes).toContain("LABEL.COMPLETENESS_CONFLICT");
  });

  it("still treats a list marked complete with nothing dosed as a contradiction", () => {
    const text = "Ingredients:\n\nEach 10 g contains: Isabgol (Plantago ovata, Sd. Husk)";
    const decoded = decode(
      text,
      answer([[row("Isabgol (Plantago ovata, Sd. Husk)", null)]], ["Each 10 g contains:"]),
    );

    expect(decoded.codes).toContain("LABEL.COMPLETENESS_CONFLICT");
  });
});
