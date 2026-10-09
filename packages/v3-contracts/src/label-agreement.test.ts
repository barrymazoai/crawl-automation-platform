import { describe, expect, it } from "vitest";
import {
  formulaAgreement,
  ingredientsAgreement,
  labelAgreementFormula,
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

const structuralChanges: [string, (shape: Formula) => void][] = [
  [
    "missing row",
    (shape) => {
      rows(shape).pop();
    },
  ],
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
  it.each(structuralChanges)("preserves a %s conflict", (_kind, change) => {
    const first = formula();
    const second = structuredClone(first);
    change(second);
    expect(formulaAgreement(first, second)).toBe("conflict");
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
    "records original %s whitespace differences",
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
        "wording",
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
