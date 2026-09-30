import { describe, expect, it } from "vitest";
import { AnchoredExtractionSchema } from "./anchored-schema.js";
import { anchor, anchoredAnswer } from "./anchored-test-helpers.js";

describe("AnchoredExtractionSchema", () => {
  it("accepts absent sections with explicit empty exclusions and issues", () => {
    const empty = { formula: null, ingredients: null, excluded: [], issues: [] };
    expect(AnchoredExtractionSchema.parse(empty)).toEqual(empty);
  });

  it.each([
    { fromLine: 0 },
    { fromLine: 1.5 },
    { toLine: -1 },
    { text: "" },
    { text: "a".repeat(20_001) },
    { start: 0 },
  ])("refuses invalid anchor fields %j", (changes) => {
    const { wire } = anchoredAnswer();
    const quote = { ...anchor(1, "Supplement Facts"), ...changes };
    const raw = { ...wire, excluded: [{ quote, reason: "heading" }] };
    expect(AnchoredExtractionSchema.safeParse(raw).success).toBe(false);
  });

  it.each([
    { formula: { servingSize: null, nutrients: [] } },
    { ingredients: { items: [] } },
    { formula: { nutrients: [{ name: anchor(1, "Vitamin C"), amount: null, dailyValue: null }] } },
    {
      ingredients: {
        items: [{ quote: anchor(1, "rice"), role: "active", parentNutrientIndex: null }],
      },
    },
    {
      ingredients: {
        items: [{ quote: anchor(1, "rice"), role: "other", parentNutrientIndex: -1 }],
      },
    },
    {
      ingredients: {
        items: [{ quote: anchor(1, "rice"), role: "other", parentNutrientIndex: 0.5 }],
      },
    },
    { excluded: [{ quote: anchor(1, "heading"), reason: "anything" }] },
    { issues: ["guess"] },
    { extra: true },
  ])("refuses missing fields, unknown values and empty present sections: %j", (changes) => {
    expect(
      AnchoredExtractionSchema.safeParse({ ...anchoredAnswer().wire, ...changes }).success,
    ).toBe(false);
  });

  it.each([
    ["nutrients", 200],
    ["items", 300],
    ["excluded", 500],
    ["issues", 3],
  ] as const)("bounds %s at %d entries", (section, limit) => {
    const nutrient = { name: anchor(1, "Vitamin C"), amount: null, dailyValue: null };
    const item = { quote: anchor(1, "rice"), role: "other", parentNutrientIndex: null };
    const exclusion = { quote: anchor(1, "Supplement Facts"), reason: "heading" };
    const raw = (length: number) => ({
      formula:
        section === "nutrients"
          ? { servingSize: null, nutrients: Array.from({ length }, () => nutrient) }
          : null,
      ingredients: section === "items" ? { items: Array.from({ length }, () => item) } : null,
      excluded: section === "excluded" ? Array.from({ length }, () => exclusion) : [],
      issues: section === "issues" ? Array.from({ length }, () => "missing_text") : [],
    });
    expect(AnchoredExtractionSchema.safeParse(raw(limit)).success).toBe(true);
    expect(AnchoredExtractionSchema.safeParse(raw(limit + 1)).success).toBe(false);
  });
});
