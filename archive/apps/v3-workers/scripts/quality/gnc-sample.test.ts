import { expect, it } from "vitest";
import { LabelImageCandidateSchema, assessLabelCandidate } from "@crawl-automation/v3-contracts";
import { fixture, compareGncSample } from "./gnc-sample.js";
function candidate() {
  const f = (text: string | null) => text === null ? null : { text, evidence: text };
  return LabelImageCandidateSchema.parse({ codec: "label-extraction/1", formula: {
    servingSize: f(fixture.expected.formula.servingSize), servingsPerContainer: f("3"),
    columns: fixture.expected.formula.columns.map(c => ({ heading: f(c.heading), rows: c.rows.map(r => ({ ...r,
      name: f(r.name), amount: f(r.amount), dailyValue: f(r.dailyValue) })) })),
  }, otherIngredients: { heading: f("Other Ingredients"), items: fixture.expected.otherIngredients.map(f) },
  formulaComplete: true, ingredientsComplete: true, exclusions: [], issues: [] });
}
it("independent visual fixture is structurally valid with 18 rows, 11 components and 7 other ingredients", () => {
  const c = candidate(); expect(assessLabelCandidate(c).status).toBe("candidate");
  expect(compareGncSample(c)).toMatchObject({ status: "match", formulaRows: 18, otherIngredients: 7, userReviewed: false });
  expect(c.formula!.columns[0]!.rows.filter(r => r.kind === "blend_component")).toHaveLength(11);
});
it.each(["dose", "unit", "daily-value", "group", "missing-row", "ingredient"])("quality fixture detects %s even when counts seem plausible", change => {
  const c = candidate(), rows = c.formula!.columns[0]!.rows;
  if (change === "dose") rows[5]!.amount!.text = "20 mg";
  if (change === "unit") rows[17]!.amount!.text = "2.4 mg";
  if (change === "daily-value") rows[5]!.dailyValue = null;
  if (change === "group") rows[17]!.parentRowIndex = 4;
  if (change === "missing-row") rows.splice(11, 1);
  if (change === "ingredient") c.otherIngredients!.items[6]!.text = "Natural Flavor";
  expect(compareGncSample(c).status).toBe("mismatch");
});
it("only established typography differences match; packaging remains separately reported", () => {
  const c = candidate(); c.formula!.columns[0]!.heading!.text = "Amounts Per Serving % DV";
  c.formula!.columns[0]!.rows[5]!.amount!.text = "200mg"; c.formula!.columns[0]!.rows[5]!.dailyValue!.text = "8.7%+";
  c.formula!.servingsPerContainer!.text = "12";
  expect(compareGncSample(c)).toMatchObject({ status: "match", printedServingsPerContainer: "12" });
});
