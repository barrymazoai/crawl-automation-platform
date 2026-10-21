import type { LabelRule } from "./rule.js";
import type { RowSubject } from "./rows.js";

const includedAmount = /^includes?\s+<?\s*\d[\d.,]*\s*(?:g|mg|mcg|µg|kcal)\b/iu;

export const amountEnclosedInNameRule: LabelRule<RowSubject> = {
  id: "amount-enclosed-in-name",
  code: "LABEL.AMOUNT_MISSING",
  added: "2026-10-21",
  why: "B0GV197H9K prints 'Includes 4g Added Sugars' as the row name and 8572440903818 prints 'Includes 3.5 g Added Sugars'; their empty amount field does not mean the dose is absent.",
  check({ rows, index }) {
    const row = rows[index];
    return row?.kind === "nutrient" && row.amount === null && includedAmount.test(row.name.text)
      ? null
      : `row ${index}: no included amount printed in the nutrient name`;
  },
};

export function acceptsAmountInName(subject: RowSubject): boolean {
  const row = subject.rows[subject.index];
  return !!row && row.amount === null && amountEnclosedInNameRule.check(subject) === null;
}
