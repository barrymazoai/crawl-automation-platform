import { describe, expect, it } from "vitest";
import answer from "./fixtures/swanson-d-ribose-answer.json" with { type: "json" };
import { decodeLabelText } from "./label-decoder.js";

// The Swanson D-Ribose label as the label core prepared it on 2026-09-29 (run 3e9ad782), and the model's answer.
const dRibose = [
  "Supplement Facts",
  "",
  "Serving Size 1 Level Scoop (5 grams)",
  "",
  "Servings Per Container 60",
  "",
  "Amount Per Serving % Daily Value",
  "",
  "Calories 20",
  "Total Carbohydrate 5 g 2%",
  "Total Sugars 5 g",
  "Includes 5 g Added Sugars 10%",
  "D-Ribose 5 g †",
  "",
  "† Daily Value not established.",
  "Percent Daily Values are based on a 2,000 calorie diet.",
  "",
  "Other Ingredients: None",
];

const decode = (lines: string[], wire: unknown) => {
  const text = lines.join("\n");
  const scope = { range: { start: 0, end: text.length } };
  return {
    text,
    result: decodeLabelText({
      scope,
      text,
      response: JSON.stringify(wire),
      policyVersion: "label-text/4",
    }),
  };
};

describe("decodeLabelText", () => {
  it("accepts the real D-Ribose answer as a candidate", () => {
    const { result } = decode(dRibose, answer);

    expect(result.codes).toEqual([]);
    expect(result.status).toBe("candidate");
  });

  it("places each repeated '5 g' on its own row, in printed order", () => {
    const { text, result } = decode(dRibose, answer);
    const rows = result.candidate.formula?.columns[0]?.rows ?? [];
    const amounts = rows.slice(1).map((row) => row.amount);

    amounts.forEach((amount, index) => {
      expect(amount && text.slice(amount.start, amount.end)).toBe("5 g");
      const previous = amounts[index - 1];
      if (amount && previous) {
        expect(amount.start).toBeGreaterThan(previous.start);
      }
    });
  });

  it("keeps the Added Sugars name whole, with its own amount inside", () => {
    const { result } = decode(dRibose, answer);
    const sugars = result.candidate.formula?.columns[0]?.rows[3];

    expect(sugars?.name.text).toBe("Includes 5 g Added Sugars");
  });

  it("accepts marketing text after the label; inside the label it goes to Review (owner 2026-10-07)", () => {
    const exclusion = {
      quote: { fromLine: 19, toLine: 19, text: "Great taste, every day" },
      reason: "marketing",
    };
    const after = decode([...dRibose, "Great taste, every day"], {
      ...answer,
      exclusions: [...answer.exclusions, exclusion],
    });
    expect(after.result.codes).not.toContain("LABEL.COVERAGE_UNCERTAIN");

    // Line 16 lies between the last Facts row and Other Ingredients: called marketing, it stays for Review.
    const inside = answer.exclusions.map((item) =>
      item.quote.fromLine === 16 ? { ...item, reason: "marketing" } : item,
    );
    const within = decode(dRibose, { ...answer, exclusions: inside });
    expect(within.result.codes).toContain("LABEL.COVERAGE_UNCERTAIN");
  });

  it("accepts the standard FDA footnote whether the model calls it footnote or metadata", () => {
    // 2026-09-30 run aa3f19fe: the same label, the same sentence, reason "metadata" (owner: this is a product).
    const exclusions = answer.exclusions.map((exclusion) =>
      exclusion.quote.text.startsWith("Percent Daily Values")
        ? { ...exclusion, reason: "metadata" }
        : exclusion,
    );
    const { result } = decode(dRibose, { ...answer, exclusions });

    expect(result.codes).toEqual([]);
    expect(result.status).toBe("candidate");
  });

  it("still sends other text excluded as metadata to Review", () => {
    const lines = [...dRibose, "Made with love"];
    const exclusion = {
      quote: { fromLine: 19, toLine: 19, text: "Made with love" },
      reason: "metadata",
    };
    const { result } = decode(lines, { ...answer, exclusions: [...answer.exclusions, exclusion] });

    expect(result.codes).toContain("LABEL.COVERAGE_UNCERTAIN");
  });

  it("flags printed words that are neither extracted nor excluded", () => {
    const { result } = decode([...dRibose, "Vitamin C 60 mg"], answer);

    expect(result.codes).toContain("LABEL.EXTRACTION_INCOMPLETE");
  });
});
