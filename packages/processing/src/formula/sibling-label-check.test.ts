import { describe, expect, it } from "vitest";
import { checkSiblingLabel, type SavedFormula } from "./sibling-label-check.js";

// The supplement facts text the Swanson adapter reads from the saved Healthy Origins D-Ribose page.
const LABEL = [
  "Supplement Facts",
  "",
  "Serving Size 1 Level Scoop (5 grams)",
  "",
  "Servings Per Container 60",
  "",
  "Amount Per Serving % Daily Value",
  "Calories 20 ",
  "Total Carbohydrate 5 g 2%",
  "Total Sugars 5 g ",
  "Includes 5 g Added Sugars 10%",
  "D-Ribose 5 g †",
  "",
  "† Daily Value not established.",
  "Percent Daily Values are based on a 2,000 calorie diet.",
  "",
  "Other Ingredients: None",
  "",
  "Suggested Use: As a dietary supplement for adults, take one (1) scoop once or twice daily.",
  "",
  "Warning: Consult a physician before use if you are pregnant.",
].join("\n");

const field = (text: string) => ({
  text,
  sourceId: "source-0",
  citation: { kind: "image" as const, evidence: text },
});
const row = (name: string, amount: string | null) => ({
  kind: "nutrient" as const,
  name: field(name),
  amount: amount ? field(amount) : null,
  dailyValue: null,
  amountStatus: "printed" as const,
  parentRowIndex: null,
});

function saved(changes: { rows?: ReturnType<typeof row>[]; others?: string[] | null } = {}) {
  const rows = changes.rows ?? [
    row("Calories", "20"),
    row("Total Carbohydrate", "5 g"),
    row("Total Sugars", "5 g"),
    row("Added Sugars", "5 g"),
    row("D-Ribose", "5 g"),
  ];
  const others = changes.others === undefined ? ["None"] : changes.others;
  return {
    formula: {
      servingSize: field("1 Level Scoop (5 grams)"),
      servingsPerContainer: field("30"),
      columns: [{ heading: field("Amount Per Serving"), rows }],
    },
    otherIngredients: others
      ? { heading: field("Other Ingredients"), items: others.map(field) }
      : null,
  } as unknown as SavedFormula;
}

describe("sibling label check", () => {
  it("matches the same formula even when servings per container differ (another size)", () => {
    expect(checkSiblingLabel(LABEL, saved())).toEqual({ match: true });
  });

  it("refuses a different amount per serving", () => {
    const rows = [row("Calories", "20"), row("D-Ribose", "3 g")];
    const result = checkSiblingLabel(LABEL, saved({ rows }));
    expect(result).toMatchObject({
      match: false,
      mismatches: expect.arrayContaining([
        { kind: "row-missing", name: "d-ribose", amount: "3 g" },
      ]),
    });
  });

  it("refuses a label that prints an ingredient the saved formula lacks", () => {
    const rows = [row("Calories", "20"), row("Total Carbohydrate", "5 g"), row("D-Ribose", "5 g")];
    const result = checkSiblingLabel(LABEL, saved({ rows }));
    expect(result).toMatchObject({
      match: false,
      mismatches: expect.arrayContaining([expect.objectContaining({ kind: "row-extra" })]),
    });
  });

  it("refuses different other ingredients, the part ingredient suppliers read", () => {
    const withOthers = LABEL.replace(
      "Other Ingredients: None",
      "Other Ingredients: Gelatin (bovine), Rice Flour, Magnesium Stearate.",
    );
    const expected = saved({ others: ["Pectin", "Rice Flour", "Magnesium Stearate"] });
    expect(checkSiblingLabel(withOthers, expected)).toMatchObject({
      match: false,
      mismatches: [
        {
          kind: "other-ingredients",
          printed: ["gelatin (bovine)", "rice flour", "magnesium stearate"],
        },
      ],
    });
    const same = saved({ others: ["Gelatin (bovine)", "Rice Flour", "Magnesium Stearate"] });
    expect(checkSiblingLabel(withOthers, same)).toEqual({ match: true });
  });

  it("refuses a different serving size", () => {
    const twoScoops = LABEL.replace("1 Level Scoop (5 grams)", "2 Level Scoops (10 grams)");
    expect(checkSiblingLabel(twoScoops, saved())).toMatchObject({
      match: false,
      mismatches: expect.arrayContaining([expect.objectContaining({ kind: "serving-size" })]),
    });
  });

  it("an empty label matches nothing", () => {
    expect(checkSiblingLabel("", saved())).toMatchObject({ match: false });
  });
});
