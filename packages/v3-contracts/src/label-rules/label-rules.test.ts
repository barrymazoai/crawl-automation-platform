import { describe, expect, it } from "vitest";
import { applyLabelRules, labelRuleTable, sameServingSize, type LabelRule } from "./index.js";
import { blendPercentageExamples } from "./examples/blend-percentage.js";
import { emptyCellExamples } from "./examples/empty-cell.js";
import { ingredientItemExamples } from "./examples/ingredient-items.js";
import { parentExamples } from "./examples/parent.js";
import { servingSizeExamples } from "./examples/serving-size.js";
import { dailyValueOnlyRowExamples } from "./examples/daily-value-only-row.js";
import { amountEnclosedInNameExamples } from "./examples/amount-enclosed-in-name.js";
import { ingredientListNotAFormulaExamples } from "./examples/ingredient-list-not-a-formula.js";
import { undosedIngredientParagraphExamples } from "./examples/undosed-ingredient-paragraph.js";
import { bracketedMayContainExamples } from "./examples/bracketed-may-contain-is-not-a-declaration.js";
import { servingUncertaintyExamples } from "./examples/servings-per-container-uncertainty-is-a-warning.js";
import { drugFactsHeadingAbsenceExamples } from "./examples/drug-facts-heading-absence-is-a-warning.js";
import { pageListWithoutFormulaExamples } from "./examples/page-list-without-formula.js";

const examples: Record<
  string,
  { pass: { subject: unknown; source: string }[]; fail: { subject: unknown; source: string }[] }
> = {
  [labelRuleTable.rows[0].id]: parentExamples,
  [labelRuleTable.rows[1].id]: blendPercentageExamples,
  [labelRuleTable.ingredientItems[0].id]: ingredientItemExamples,
  [labelRuleTable.cells[0].id]: emptyCellExamples,
  [labelRuleTable.rows[2].id]: amountEnclosedInNameExamples,
  [labelRuleTable.dailyValueCells[0].id]: dailyValueOnlyRowExamples,
  [labelRuleTable.formulas[0].id]: ingredientListNotAFormulaExamples,
  [labelRuleTable.formulas[1].id]: undosedIngredientParagraphExamples,
  [labelRuleTable.ingredientRoles[0].id]: bracketedMayContainExamples,
  [labelRuleTable.servingUncertainty[0].id]: servingUncertaintyExamples,
  [labelRuleTable.drugFactsHeadingAbsence[0].id]: drugFactsHeadingAbsenceExamples,
  [labelRuleTable.pageListWithoutFormula[0].id]: pageListWithoutFormulaExamples,
};
const checkRules: LabelRule<unknown>[] = [
  ...labelRuleTable.rows,
  ...labelRuleTable.ingredientItems,
  ...labelRuleTable.cells,
  ...labelRuleTable.dailyValueCells,
  ...labelRuleTable.formulas,
  ...labelRuleTable.ingredientRoles,
  ...labelRuleTable.servingUncertainty,
] as LabelRule<unknown>[];
const warningRules: LabelRule<unknown>[] = [
  ...labelRuleTable.drugFactsHeadingAbsence,
  ...labelRuleTable.pageListWithoutFormula,
] as LabelRule<unknown>[];
const allRules = [...checkRules, ...warningRules];

describe("label rule table", () => {
  it("every rule has a unique ID, a date, a reason and real examples on both sides", () => {
    const ids = [
      ...allRules.map((rule) => rule.id),
      ...labelRuleTable.servingSize.map((rule) => rule.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of [...allRules, ...labelRuleTable.servingSize]) {
      expect(rule.added).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(rule.why.length).toBeGreaterThan(20);
    }
    for (const rule of allRules) {
      const own = examples[rule.id];
      expect(own, rule.id).toBeDefined();
      expect(own!.pass.length + own!.fail.length).toBeGreaterThan(0);
      expect(
        [...own!.pass, ...own!.fail].some((e) => !e.source.startsWith("constructed")),
        rule.id,
      ).toBe(true);
    }
  });

  for (const rule of checkRules) {
    const own = examples[rule.id] ?? { pass: [], fail: [] };
    it.each(own.pass.map((e) => [e.source, e.subject] as const))(
      `${rule.id} accepts %s`,
      (_, subject) => {
        expect(rule.check(subject)).toBeNull();
      },
    );
    it.each(own.fail.map((e) => [e.source, e.subject] as const))(
      `${rule.id} rejects %s`,
      (_, subject) => {
        expect(applyLabelRules([rule], subject)).toEqual([
          expect.objectContaining({ code: rule.code, rule: rule.id }),
        ]);
      },
    );
  }

  for (const rule of warningRules) {
    const own = examples[rule.id] ?? { pass: [], fail: [] };
    it.each(own.pass.map((e) => [e.source, e.subject] as const))(
      `${rule.id} warns for %s`,
      (_, subject) => {
        expect(applyLabelRules([rule], subject)).toEqual([
          expect.objectContaining({ code: rule.code, rule: rule.id }),
        ]);
      },
    );
    it.each(own.fail.map((e) => [e.source, e.subject] as const))(
      `${rule.id} does not warn for %s`,
      (_, subject) => {
        expect(rule.check(subject)).toBeNull();
      },
    );
  }

  it.each(servingSizeExamples.same.map((e) => [e.source, ...e.subject] as const))(
    "serving sizes are the same: %s",
    (_, one, other) => expect(sameServingSize(one, other)).toBe(true),
  );
  it.each(servingSizeExamples.different.map((e) => [e.source, ...e.subject] as const))(
    "serving sizes differ: %s",
    (_, one, other) => expect(sameServingSize(one, other)).toBe(false),
  );
});
