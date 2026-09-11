import { expect, it } from "vitest";
import { gncLabelFixture } from "../../v3-contracts/src/label.fixture.js";
import { compareLabelStructure } from "./label-comparison.js";
const source = (candidate = gncLabelFixture()) => ({ kind: "image" as const, candidate });
it("identical group structures compare without merging equal group names", () => {
  expect(compareLabelStructure(source(), source())).toEqual({ status: "match", codes: [] });
});
it("a same-named but wrong parent remains unresolved", () => {
  const b = source(); b.candidate.formula!.columns[0]!.rows[14]!.parentRowIndex = 4;
  expect(compareLabelStructure(source(), b).status).toBe("unresolved");
});
it.each(["dose", "column", "component"])("a changed %s conflicts", kind => {
  const b = source(), column = b.candidate.formula!.columns[0]!;
  if (kind === "dose") column.rows[14]!.amount!.text = "200 mg";
  if (kind === "column") column.heading!.text = "Per two servings";
  if (kind === "component") column.rows[14]!.name.text = "Different component";
  expect(compareLabelStructure(source(), b).codes).toContain("LABEL.FORMULA_CONFLICT");
});
it("3 versus 12 is preserved as a conflict, not pack-count arithmetic", () => {
  const b = source(); b.candidate.formula!.servingsPerContainer!.text = "12";
  expect(compareLabelStructure(source(), b)).toEqual({ status: "conflict", codes: ["LABEL.CONTAINER_COUNT_CONFLICT"] });
});
it("missing Other Ingredients and dose-free empty sources are not matches", () => {
  const b = source(); b.candidate.otherIngredients = null;
  expect(compareLabelStructure(source(), b).codes).toContain("LABEL.OTHER_INGREDIENTS_CONFLICT");
  b.candidate.formula = null;
  expect(compareLabelStructure(source(), b).status).toBe("unresolved");
});
it("does not erase trademark, punctuation or dose-unit differences as a guess", () => {
  const b = source(); b.candidate.formula!.columns[0]!.rows[4]!.name.text = "FocusFuel Electrolyte Blend";
  expect(compareLabelStructure(source(), b).status).toBe("conflict");
});
