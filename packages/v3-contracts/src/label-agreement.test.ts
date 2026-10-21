import { describe, expect, it } from "vitest";
import {
  formulaAgreement,
  ingredientsAgreement,
  ingredientListRelation,
  joinFormulaSections,
  labelAgreementFormula,
  pageIngredientsIncludeActives,
  preferFormulaSource,
} from "./label-agreement.js";
import { gncLabelFixture } from "./label.fixture.js";

const formula = () => {
  const shape = labelAgreementFormula(gncLabelFixture());
  if (!shape) {
    throw new Error("Fixture requires a formula");
  }
  return shape;
};
type Formula = ReturnType<typeof formula>;
const rows = (shape: Formula) => {
  const column = shape.columns[0];
  if (!column) {
    throw new Error("Fixture requires a column");
  }
  return column.rows;
};
const row = (shape: Formula, index: number) => {
  const found = rows(shape)[index];
  if (!found) {
    throw new Error("Fixture requires a row");
  }
  return found;
};
type FormulaRow = ReturnType<typeof row>;
const factRow = (
  kind: FormulaRow["kind"], name: string, amount: string | null,
  dailyValue: string | null = null, parentRowIndex: number | null = null,
  amountStatus: FormulaRow["amountStatus"] = amount === null ? "not_declared" : "printed",
): FormulaRow => ({ kind, name, amount, amountStatus, dailyValue, parentRowIndex });
const oneColumn = (values: FormulaRow[], heading = "Amount Per Serving") => {
  const shape = formula();
  shape.columns = [{ heading, rows: values }];
  return shape;
};

const structuralChanges: [string, (shape: Formula) => void][] = [
  [
    "extra row",
    (shape) => {
      rows(shape).push({ ...row(shape, 17) });
    },
  ],
  [
    "row order",
    (shape) => {
      rows(shape).reverse();
    },
  ],
  [
    "row kind",
    (shape) => {
      row(shape, 17).kind = "nutrient";
    },
  ],
  [
    "parent index",
    (shape) => {
      row(shape, 14).parentRowIndex = 4;
    },
  ],
  [
    "amount status",
    (shape) => {
      row(shape, 14).amountStatus = "not_declared";
    },
  ],
  [
    "missing amount",
    (shape) => {
      row(shape, 14).amount = null;
    },
  ],
  [
    "daily value",
    (shape) => {
      row(shape, 14).dailyValue = "5%";
    },
  ],
  [
    "missing column",
    (shape) => {
      shape.columns.pop();
    },
  ],
  [
    "extra column",
    (shape) => {
      shape.columns.push({ heading: "Second", rows: [] });
    },
  ],
  [
    "serving size",
    (shape) => {
      shape.servingSize = "3";
    },
  ],
  [
    "container count",
    (shape) => {
      shape.servingsPerContainer = "12";
    },
  ],
];

describe("shared label agreement boundaries", () => {
  it("separates a named cinnamon active from the page's full ingredient list", () => {
    expect(pageIngredientsIncludeActives(
      ["Organic Glycerin", "Water"],
      ["Ceylon Cinnamon (Cinnamomum verum) Dried Bark", "Water", "Organic Glycerin"],
      ["Ceylon Cinnamon Bark Extract"],
    )).toBe(true);
  });

  it("accepts an image subset of the page after named actives are removed", () => {
    expect(pageIngredientsIncludeActives(
      ["Organic Glycerin", "Water"],
      ["Ceylon Cinnamon Bark Extract", "Water", "Citric Acid", "Organic Glycerin"],
      ["Ceylon Cinnamon Bark Extract"],
    )).toBe(true);
  });

  it("does not remove a similar but different cinnamon ingredient", () => {
    expect(pageIngredientsIncludeActives(
      ["Organic Glycerin", "Water"],
      ["Cinnamon Bark Oil", "Water", "Organic Glycerin"],
      ["Cinnamon Extract"],
    )).toBe(false);
  });

  it("normalizes typography, conjunctions and an attached Contains tail", () => {
    expect(ingredientListRelation(
      ["Ｃｅｌｌｕｌｏｓｅ（ plant ）.", "Salt & pepper. Contains: Soy"],
      ["cellulose (plant)", "salt and pepper"],
    )).toBe("wording");
  });

  it("accepts an explicit terminal conjunction split into two adjacent items", () => {
    expect(ingredientListRelation(["Cellulose", "Salt & pepper"], ["Cellulose", "salt", "pepper"]))
      .toBe("wording");
    expect(ingredientListRelation(["Sodium chloride"], ["Sodium", "chloride"])).toBe("conflict");
  });
  it.each(structuralChanges)("preserves a %s conflict", (_kind, change) => {
    const first = formula();
    const second = structuredClone(first);
    change(second);
    expect(formulaAgreement(first, second)).toBe("conflict");
  });


  it("treats normalized readings of one panel as exact", () => {
    const first = formula();
    const second = structuredClone(first);
    row(first, 5).amount = "1,200 mcg.";
    row(second, 5).amount = "1200 µg";
    row(first, 5).dailyValue = "12%†";
    row(second, 5).dailyValue = "12 %**";
    row(second, 5).name = `  ${row(first, 5).name?.toUpperCase()}\n`;
    expect(formulaAgreement(first, second)).toBe("exact");
  });

  it("accepts missing trailing rows and a missing group heading as subsets", () => {
    const first = formula();
    const shorter = structuredClone(first);
    rows(shorter).splice(-2);
    expect(formulaAgreement(first, shorter)).toBe("subset");
    const noGroup = structuredClone(first);
    rows(noGroup).splice(4, 1);
    expect(formulaAgreement(first, noGroup)).toBe("subset");
  });

  it("B078SD9ZY5 covers a truncated blend and an extra amino-acid column", () => {
    const weak = oneColumn([
      factRow("nutrient", "Sodium", "45 mg"),
      factRow("blend_total", "Multi Collagen Complex", "7.8 g"),
      factRow("blend_component", "Bovine Bone Broth Hydrolyzed Protein", null, null, 1),
      factRow("blend_component", "Chi Bone Broth Collagen Concentrate", null, null, 1),
      factRow("blend_component", "Eggshell Membrane Coll", null, null, 1),
    ]);
    const full = oneColumn([
      factRow("nutrient", "Sodium", "45 mg", "2%"),
      factRow("blend_total", "Multi Collagen Complex", "7.8 g", "†"),
      factRow("blend_component", "Hydrolyzed Bovine Bone Broth", null, null, 1),
      factRow("blend_component", "Hydrolyzed Protein", null, null, 1),
      factRow("blend_component", "Chicken Bone Broth Collagen Concentrate", null, null, 1),
      factRow("blend_component", "Eggshell Membrane Collagen", null, null, 1),
    ]);
    full.columns.push({ heading: "Amount Per Serving", rows: [factRow("nutrient", "Alanine", "616 mg")] });
    expect(formulaAgreement(weak, full)).toBe("subset");
    expect(formulaAgreement(full, weak)).toBe("subset");
    full.columns[0]!.rows[0]!.amount = "46 mg";
    expect(formulaAgreement(weak, full)).toBe("conflict");
  });

  it("B00I64FVXS covers both crop sections with offset blend parents and footnoted DV", () => {
    const top = oneColumn([
      factRow("nutrient", "Total Carbohydrate", "7 g", "2%"),
      factRow("nutrient", "Zinc (as gluconate)§", "3 mg", "20%"),
    ]);
    const tail = oneColumn([
      factRow("nutrient", "Selenium (as selenomethionine)§", "100 mcg", "143%"),
      factRow("blend_total", "Certified Organic Whole Foods§", "5700 mg", "†"),
      factRow("blend_component", "Glucosamine", null, null, 1),
      factRow("blend_component", "selenium (as selenomethionine)", null, null, 1),
      factRow("nutrient", "Beet Root Extract (rich in Dimethylglycine)‡", "20 mg", "†"),
      factRow("blend_component", "L. sporogenes [a.k.a. Bacillus coagulans]", null, null, 1),
      factRow("nutrient", "Co-enzyme Q10", "3 mg", "†"),
    ]);
    tail.servingSize = null;
    tail.servingsPerContainer = null;
    const full = oneColumn([
      factRow("nutrient", "Total Carbohydrate", "7 g", "2%*"),
      factRow("nutrient", "Zinc (as gluconate)§", "3 mg", "20%"),
      factRow("nutrient", "Selenium (as selenomethionine)§", "100 mcg", "143%"),
      factRow("blend_total", "Certified Organic Whole Foods§", "5700 mg"),
      factRow("blend_component", "Glucosamine", "125 mg", null, 3),
      factRow("blend_component", "selenium (as selenomethionine)", null, null, 3),
      factRow("blend_component", "Beet Root Extract (rich in Dimethylglycine)‡", "20 mg", null, 3),
      factRow("blend_component", "L. sporogenes [a.k.a. Bacillus coagulans]", "1 billion viable cells", null, 3),
      factRow("nutrient", "Co-enzyme Q10", "3 mg"),
    ]);
    expect(formulaAgreement(top, tail)).toBe("sections");
    expect(formulaAgreement(top, full)).toBe("subset");
    expect(formulaAgreement(tail, full)).toBe("subset");
    expect(formulaAgreement(joinFormulaSections(top, tail), full)).toBe("subset");
    full.columns[0]!.rows[2]!.amount = "200 mcg";
    expect(formulaAgreement(tail, full)).toBe("conflict");
    expect(formulaAgreement(joinFormulaSections(top, tail), full)).toBe("conflict");
  });

  it("B07434SZ9W covers unreadable amino amounts and compatible panel titles", () => {
    const weak = oneColumn([
      factRow("nutrient", "Calories", "60"),
      factRow("nutrient", "Bone Broth Hydrolyzed Protein", "8 g"),
    ]);
    weak.columns.push({ heading: "Typical Amino Acid Profile — Amount Per Serving", rows: [
      factRow("nutrient", "Alanine", null, null, null, "unreadable"),
      factRow("nutrient", "Arginine", null, null, null, "unreadable"),
    ] });
    const full = structuredClone(weak);
    full.columns[0]!.heading = "Supplement Facts";
    full.columns[0]!.rows[1]!.name = "Bovine Bone Broth Hydrolyzed Protein";
    full.columns[1]!.heading = "Typical Amino Acid Profile";
    full.columns[1]!.rows[0]!.amount = "1332 mg";
    full.columns[1]!.rows[0]!.amountStatus = "printed";
    full.columns[1]!.rows[1]!.amount = "1200 mg";
    full.columns[1]!.rows[1]!.amountStatus = "printed";
    expect(formulaAgreement(weak, full)).toBe("subset");
    full.columns[0]!.rows[1]!.amount = "9 g";
    expect(formulaAgreement(weak, full)).toBe("conflict");
  });

  it("prefers more printed amounts, DV cells, serving metadata and complete names", () => {
    const changes = [
      (weak: ReturnType<typeof gncLabelFixture>, _full: ReturnType<typeof gncLabelFixture>) => {
        weak.formula!.columns[0]!.rows[0]!.amount = null;
        weak.formula!.columns[0]!.rows[0]!.amountStatus = "unreadable";
      },
      (_weak: ReturnType<typeof gncLabelFixture>, full: ReturnType<typeof gncLabelFixture>) => {
        full.formula!.columns[0]!.rows[0]!.dailyValue = { text: "2%", evidence: "2%" };
      },
      (weak: ReturnType<typeof gncLabelFixture>, _full: ReturnType<typeof gncLabelFixture>) => {
        weak.formula!.servingSize = null;
      },
      (weak: ReturnType<typeof gncLabelFixture>, _full: ReturnType<typeof gncLabelFixture>) => {
        weak.formula!.columns[0]!.rows[0]!.name.text = "Cal";
      },
    ];
    for (const change of changes) {
      const weak = gncLabelFixture(), full = structuredClone(weak);
      weak.formulaComplete = false;
      full.formulaComplete = false;
      change(weak, full);
      expect(preferFormulaSource(weak, full)).toBe(true);
      expect(preferFormulaSource(full, weak)).toBe(false);
    }
  });

  it("keeps a changed amount and disjoint material rows in conflict", () => {
    const first = formula();
    const second = structuredClone(first);
    row(first, 5).amount = "500 mg";
    row(second, 5).amount = "50 mg";
    expect(formulaAgreement(first, second)).toBe("conflict");
    const third = structuredClone(first);
    rows(first).pop();
    rows(third).splice(0, 1);
    expect(formulaAgreement(first, third)).toBe("conflict");
  });

  it("keeps a changed group heading in conflict even when another group repeats", () => {
    const first = formula(), second = structuredClone(first);
    row(second, 4).name = "Different Electrolyte Blend";
    expect(formulaAgreement(first, second)).toBe("conflict");
    const moved = structuredClone(first);
    row(moved, 17).kind = "nutrient";
    row(moved, 17).parentRowIndex = null;
    expect(formulaAgreement(first, moved)).toBe("conflict");
  });

  it("keeps column order and headings", () => {
    const first = formula();
    first.columns.push({ heading: "Second serving", rows: [{ ...row(first, 0) }] });
    const second = structuredClone(first);
    second.columns.reverse();
    expect(formulaAgreement(first, second)).toBe("conflict");
  });

  it("keeps a missing formula or list distinct from a present one", () => {
    expect(formulaAgreement(formula(), null)).toBe("conflict");
    expect(ingredientsAgreement(["cellulose"], null)).toBe("conflict");
  });

  it.each(["name", "amount", "dailyValue"] as const)(
    "accepts original %s whitespace differences without warning",
    (key) => {
      const first = gncLabelFixture();
      const second = structuredClone(first);
      const target = second.formula?.columns[0]?.rows[0];
      if (!target) {
        throw new Error("Fixture requires a row");
      }
      if (key === "dailyValue") {
        const original = first.formula?.columns[0]?.rows[0];
        if (original) {
          original.dailyValue = { text: "5 %", evidence: "5 %" };
        }
        target.dailyValue = { text: " 5   % ", evidence: "5 %" };
      } else if (target[key]) {
        target[key].text = ` ${target[key].text} `;
      }
      expect(formulaAgreement(labelAgreementFormula(first), labelAgreementFormula(second))).toBe(
        "exact",
      );
    },
  );

  it("only strips a leading ingredient qualifier", () => {
    expect(
      ingredientsAgreement(["cellulose (contains 2% or less of: casein)"], ["cellulose (casein)"]),
    ).toBe("conflict");
  });

  it("records ingredient whitespace changes even with the typography policy", () => {
    expect(
      ingredientsAgreement(
        ["microcrystalline  cellulose"],
        ["microcrystalline cellulose"],
        "label-typography/1",
      ),
    ).toBe("wording");
  });

  it("treats case, trailing punctuation and footnote or trademark marks as wording (CRAWLV3-214)", () => {
    expect(ingredientsAgreement(["Dry Roasted Almonds"], ["DRY ROASTED ALMONDS."])).toBe("wording");
    expect(
      ingredientsAgreement(
        ["Natural wild raspberry flavor‡", "Enhanced Collagen™ hydrolyzed bovine collagen"],
        ["Natural Wild Raspberry Flavor", "Enhanced Collagen hydrolyzed bovine collagen"],
      ),
    ).toBe("wording");
    expect(ingredientsAgreement(["Organic cane sugar*"], ["organic cane sugar"])).toBe("wording");
    expect(ingredientsAgreement(["Almonds!"], ["almonds"])).toBe("wording");
    expect(ingredientsAgreement(["almonds"], ["cashews"])).toBe("conflict");
    expect(ingredientsAgreement(["A*B"], ["AB"])).toBe("conflict");
  });

  it("does not erase ingredient punctuation or item boundaries", () => {
    expect(
      ingredientsAgreement(["casein, potassium citrate"], ["casein", "potassium citrate"]),
    ).toBe("conflict");
    expect(ingredientsAgreement(["casein-peptones"], ["casein peptones"])).toBe("conflict");
  });
});
