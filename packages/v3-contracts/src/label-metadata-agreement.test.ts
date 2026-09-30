import { describe, expect, it } from "vitest";
import {
  formulaAgreement,
  labelAgreementFormula,
  labelMetadataAgreement,
} from "./label-agreement.js";
import { gncLabelFixture } from "./label.fixture.js";

const field = (text: string) => ({ text, evidence: text });
const nutrient = (name: string, amount: string, dailyValue: string) => ({
  kind: "nutrient" as const,
  name: field(name),
  amount: field(amount),
  dailyValue: field(dailyValue),
  amountStatus: "printed" as const,
  parentRowIndex: null,
});

/** Reconstruct the two-image field differences reported from the real Prevagen candidates. */
function reportedFormula(detailed = false, tablet = false) {
  const unit = tablet ? "Tablet" : "Capsule";
  const lower = unit.toLowerCase();
  return {
    servingSize: field(detailed ? `1 ${lower}` : `1 ${unit}`),
    servingsPerContainer: detailed ? field(`30 ${lower}s per bottle`) : null,
    columns: [
      {
        heading: field(detailed ? `Amount per ${lower}` : `Amount Per ${unit}`),
        rows: [
          nutrient(
            detailed ? "Vitamin D (as D3 cholecalciferol)" : "Vitamin D (as cholecalciferol)",
            "50 mcg",
            "250%",
          ),
          nutrient("Apoaequorin", "10 mg", detailed ? "<1% **" : "<1%**"),
        ],
      },
    ],
  };
}

describe("reported formula metadata differences", () => {
  it.each([false, true])("agrees on the combined real field differences (tablet=%s)", (tablet) => {
    const first = reportedFormula(false, tablet);
    const second = reportedFormula(true, tablet);
    const original = structuredClone(first);
    expect(formulaAgreement(first, second)).toBe("wording");
    expect(formulaAgreement(second, first)).toBe("wording");
    const firstCandidate = { ...gncLabelFixture(), formula: first };
    const secondCandidate = { ...gncLabelFixture(), formula: second };
    expect(
      formulaAgreement(
        labelAgreementFormula(firstCandidate),
        labelAgreementFormula(secondCandidate),
      ),
    ).toBe("wording");
    expect(first).toEqual(original);
    expect(first.servingsPerContainer).toBeNull();
  });

  it("keeps 30 versus 60 capsules as a conflict", () => {
    const first = reportedFormula();
    const second = reportedFormula();
    first.servingsPerContainer = field("30 capsules");
    second.servingsPerContainer = field("60 capsules");
    expect(formulaAgreement(first, second)).toBe("conflict");
  });

  it.each(["30 capsules per bottle", "30 tablets", "30 Tablets Per Bottle", "60 capsules"])(
    "accepts a one-sided printed count: %s",
    (count) => {
      const first = reportedFormula();
      const second = reportedFormula();
      second.servingsPerContainer = field(count);
      expect(formulaAgreement(first, second)).toBe("wording");
      expect(formulaAgreement(second, first)).toBe("wording");
    },
  );

  it("ignores citation evidence and text anchors when raw formula texts are identical", () => {
    const first = reportedFormula();
    const second = structuredClone(first);
    second.servingSize = { ...second.servingSize, evidence: "different image region" };
    const anchored = { ...first, servingSize: { ...first.servingSize, start: 10, end: 19 } };
    expect(formulaAgreement(first, second)).toBe("exact");
    expect(formulaAgreement(first, anchored)).toBe("exact");
  });

  it.each([
    ["Amount Per Capsule:", "amount   per capsule"],
    ["1 Capsule", " 1 CAPSULE. "],
    ["30 Tablets Per Bottle", "30 tablets per bottle."],
    ["30 capsules", "30   capsules"],
  ])("normalizes metadata case/whitespace/punctuation: %s / %s", (first, second) => {
    expect(labelMetadataAgreement(first, second)).toBe("wording");
  });

  it.each([
    ["1 Capsule", "2 capsules"],
    ["1 Capsule", "1 Tablet"],
    ["Amount Per Capsule", "Amount per tablet"],
    ["1.5 capsules", "15 capsules"],
    ["1.5 capsules", "1 5 capsules"],
    ["1/2 tablet", "1 2 tablet"],
    ["-1 capsule", "1 capsule"],
    ["1%", "1"],
    ["1 mg/ml", "1 mg ml"],
    ["30 capsules", "60 capsules"],
  ])("preserves real metadata numbers and unit meanings: %s / %s", (first, second) => {
    expect(labelMetadataAgreement(first, second)).toBe("conflict");
  });

  it.each(["servingSize", "servingsPerContainer", "heading"] as const)(
    "treats a one-sided %s as missing metadata",
    (key) => {
      const first = labelAgreementFormula({ ...gncLabelFixture(), formula: reportedFormula(true) });
      const second = structuredClone(first);
      if (!first || !second) {
        throw new Error("Fixture requires a formula");
      }
      if (key === "heading") {
        const column = second.columns[0];
        if (column) {
          column.heading = null;
        }
      } else {
        second[key] = null;
      }
      expect(formulaAgreement(first, second)).toBe("wording");
    },
  );

  it.each(["<2%**", "1%**", "<1%*"])("keeps real daily-value differences: %s", (dailyValue) => {
    const first = reportedFormula();
    const second = reportedFormula();
    const row = second.columns[0]?.rows[1];
    if (row) {
      row.dailyValue = field(dailyValue);
    }
    expect(formulaAgreement(first, second)).toBe("conflict");
  });
});
