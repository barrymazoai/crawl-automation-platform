import { describe, expect, it } from "vitest";
import { sameIngredientsFormula } from "./india-same-ingredients.js";

/** Readings copied from the amazon.in Reviews of the 2026-11-07 rerun. */
const formula = (serving: string | null, rows: [string, string | null][]) => ({
  servingSize: serving ? { text: serving } : null,
  columns: [
    {
      rows: rows.map(([name, amount]) => ({
        name: { text: name },
        amount: amount ? { text: amount } : null,
      })),
    },
  ],
});

describe("India: two readings of one label name an ingredient shorter or longer", () => {
  it("agree on the same ingredient and amount (B09DKW81VV methylcobalamin)", () => {
    const back = formula("1 tablet", [["Vitamin B12 (Methylcobalamin IP)", "1500 mcg"]]);
    const front = formula("film coated tablet", [["Methylcobalamin IP", "1500 mcg"]]);
    expect(sameIngredientsFormula(front, back)).toBe(true);
    expect(sameIngredientsFormula(back, front)).toBe(true);
  });

  it("still disagree on another amount (Rasayanam: page 500 mg, label 600 mg)", () => {
    const page = formula(null, [
      ["KSM-66 Ashwagandha root extract (Withania somnifera)", "500 mg"],
    ]);
    const label = formula("1 capsule", [
      ["KSM-66 Ashwagandha root extract (Withania somnifera) 5% withanolides", "600 mg"],
    ]);
    expect(sameIngredientsFormula(page, label)).toBe(false);
  });

  it("still disagree when one version prints another sugar (B092ZXX7XP, two label versions)", () => {
    const one = formula("1 gummy approximately 4 g", [
      ["Sugars (naturally occurring sugars)", "0.58 g"],
      ["Grape seed extract", "10 mg"],
    ]);
    const other = formula("1 gummy approximately 3.7 g", [
      ["Sugars (naturally occuring sugars)", "0.38 g"],
      ["Grape seed extract", "10 mg"],
    ]);
    expect(sameIngredientsFormula(one, other)).toBe(false);
  });

  it("still disagree on another serving or a name with no word in common", () => {
    const one = formula("2 tablets", [["Methylcobalamin", "1500 mcg"]]);
    const other = formula("1 tablet", [["Methylcobalamin", "1500 mcg"]]);
    expect(sameIngredientsFormula(one, other)).toBe(false);
    const zinc = formula(null, [["Zinc", "10 mg"]]);
    const iron = formula(null, [["Iron", "10 mg"]]);
    expect(sameIngredientsFormula(zinc, iron)).toBe(false);
  });

  it("keep vitamins apart by their short names, one to one (B6 is not B2)", () => {
    const partial = formula(null, [["Vitamin B6", "1.4 mg"]]);
    const complete = formula(null, [
      ["Vitamin B2", "1.4 mg"],
      ["Vitamin B6", "2 mg"],
    ]);
    expect(sameIngredientsFormula(partial, complete)).toBe(false);
    const twice = formula(null, [
      ["Methylcobalamin", "1500 mcg"],
      ["Methylcobalamin IP", "1500 mcg"],
    ]);
    const once = formula(null, [["Vitamin B12 (Methylcobalamin IP)", "1500 mcg"]]);
    expect(sameIngredientsFormula(twice, once)).toBe(false);
  });
});
