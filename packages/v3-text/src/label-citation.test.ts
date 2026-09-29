import { describe, expect, it } from "vitest";
import answer from "./fixtures/swanson-d-ribose-answer.json" with { type: "json" };
import { decodeLabelText } from "./label-extraction.js";

// The Swanson D-Ribose label as the label core prepared it on 2026-09-29 (run 3e9ad782), and the model's real answer.
const dRibose = [
  "Supplement Facts", "", "Serving Size 1 Level Scoop (5 grams)", "", "Servings Per Container 60", "",
  "Amount Per Serving % Daily Value", "", "Calories 20", "Total Carbohydrate 5 g 2%", "Total Sugars 5 g",
  "Includes 5 g Added Sugars 10%", "D-Ribose 5 g †", "", "† Daily Value not established.",
  "Percent Daily Values are based on a 2,000 calorie diet.", "", "Other Ingredients: None",
];
const decode = (lines: string[], wire: unknown) => {
  const text = lines.join("\n");
  return { text, result: decodeLabelText({ range: { start: 0, end: text.length } }, text, JSON.stringify(wire), "label-text/4") };
};
const rowsOf = (result: ReturnType<typeof decodeLabelText>) => result.candidate.formula!.columns[0]!.rows;

describe("label quotes of words printed more than once", () => {
  it("accepts the real D-Ribose answer: the Added Sugars name encloses its own amount", () => {
    const { result } = decode(dRibose, answer);
    const sugars = rowsOf(result)[3]!;
    expect(sugars.name.text).toBe("Includes 5 g Added Sugars");
    expect(sugars.amount!.text).toBe("5 g");
    expect(sugars.amount!.start).toBeGreaterThan(sugars.name.start);
    expect(result.codes).not.toContain("TEXT.CITATION_INVALID");
  });

  it("the whole real D-Ribose answer is now a candidate, standard FDA footnote included", () => {
    const { result } = decode(dRibose, answer);
    expect(result.codes).toEqual([]);
    expect(result.status).toBe("candidate");
  });

  it("places each '5 g' on its own row, in printed order", () => {
    const { text, result } = decode(dRibose, answer);
    const amounts = rowsOf(result).slice(1).map(row => row.amount!);
    for (const [index, amount] of amounts.entries()) {
      expect(text.slice(amount.start, amount.end)).toBe("5 g");
      if (index) expect(amount.start).toBeGreaterThan(amounts[index - 1]!.start);
    }
  });

  it("places repeated ingredient words on the whole list entry, in list order", () => {
    const lines = [...dRibose.slice(0, -1), "Other Ingredients: Chicken Meal, Chicken, Chicken Fat, Banana, Rice, Banana"];
    const items = ["Chicken Meal", "Chicken", "Chicken Fat", "Banana", "Rice", "Banana"].map(text => ({ fromLine: 18, toLine: 18, text }));
    const { text, result } = decode(lines, { ...answer, otherIngredients: { ...answer.otherIngredients, items } });
    const quoted = result.candidate.otherIngredients!.items;
    expect(quoted.map(q => q.text)).toEqual(["Chicken Meal", "Chicken", "Chicken Fat", "Banana", "Rice", "Banana"]);
    expect(text.slice(quoted[1]!.start - 2, quoted[1]!.end + 1)).toBe(", Chicken,");
    expect(quoted[5]!.start).toBeGreaterThan(quoted[3]!.start);
    expect(result.codes).not.toContain("LABEL.INGREDIENT_BOUNDARY");
  });

  it("two quotes of words printed once stay a Review (unchanged unique-match path)", () => {
    const lines = [...dRibose.slice(0, -1), "Other Ingredients: Banana"];
    const items = ["Banana", "Banana"].map(text => ({ fromLine: 18, toLine: 18, text }));
    const { result } = decode(lines, { ...answer, otherIngredients: { ...answer.otherIngredients, items } });
    expect(result.codes).toContain("LABEL.INGREDIENT_BOUNDARY");
  });

  it("a repeated word with no free whole occurrence left is refused", () => {
    const lines = [...dRibose.slice(0, -1), "Other Ingredients: Banana, Banana Chips"];
    const items = ["Banana", "Banana", "Banana Chips"].map(text => ({ fromLine: 18, toLine: 18, text }));
    expect(() => decode(lines, { ...answer, otherIngredients: { ...answer.otherIngredients, items } })).toThrow("TEXT.CITATION_INVALID");
  });

  it("still refuses a name that is not printed", () => {
    const wire = structuredClone(answer);
    wire.formula.columns[0]!.rows[4]!.name.text = "Ribose Powder";
    expect(() => decode(dRibose, wire)).toThrow();
  });
});
