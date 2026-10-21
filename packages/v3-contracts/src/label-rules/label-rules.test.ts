import { describe, expect, it } from "vitest";
import { applyLabelRules, labelRuleTable, sameServingSize, type LabelRule } from "./index.js";
import { blendPercentageExamples } from "./examples/blend-percentage.js";
import { emptyCellExamples } from "./examples/empty-cell.js";
import { ingredientItemExamples } from "./examples/ingredient-items.js";
import { parentExamples } from "./examples/parent.js";
import { servingSizeExamples } from "./examples/serving-size.js";

const examples: Record<string, { pass: { subject: unknown; source: string }[]; fail: { subject: unknown; source: string }[] }> = {
  [labelRuleTable.rows[0].id]: parentExamples,
  [labelRuleTable.rows[1].id]: blendPercentageExamples,
  [labelRuleTable.ingredientItems[0].id]: ingredientItemExamples,
  [labelRuleTable.cells[0].id]: emptyCellExamples,
};
const checkRules: LabelRule<unknown>[] = [...labelRuleTable.rows, ...labelRuleTable.ingredientItems, ...labelRuleTable.cells] as LabelRule<unknown>[];

describe("label rule table", () => {
  it("every rule has a unique ID, a date, a reason and real examples on both sides", () => {
    const ids = [...checkRules.map((rule) => rule.id), ...labelRuleTable.servingSize.map((rule) => rule.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of [...checkRules, ...labelRuleTable.servingSize]) {
      expect(rule.added).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(rule.why.length).toBeGreaterThan(20);
    }
    for (const rule of checkRules) {
      const own = examples[rule.id];
      expect(own, rule.id).toBeDefined();
      expect(own!.pass.length + own!.fail.length).toBeGreaterThan(0);
      expect([...own!.pass, ...own!.fail].some((e) => !e.source.startsWith("constructed")), rule.id).toBe(true);
    }
  });

  for (const rule of checkRules) {
    const own = examples[rule.id] ?? { pass: [], fail: [] };
    it.each(own.pass.map((e) => [e.source, e.subject] as const))(`${rule.id} accepts %s`, (_, subject) => {
      expect(rule.check(subject)).toBeNull();
    });
    it.each(own.fail.map((e) => [e.source, e.subject] as const))(`${rule.id} rejects %s`, (_, subject) => {
      expect(applyLabelRules([rule], subject)).toEqual([expect.objectContaining({ code: rule.code, rule: rule.id })]);
    });
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
