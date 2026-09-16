import { expect, it } from "vitest";
import { z } from "zod";
import { LabelImageCandidateSchema, LabelTextWireSchema, assessLabelCandidate, labelFormulaStructure } from "./label-extraction.js";
import { VisionCandidateSchema } from "./vision.js";
import { gncLabelFixture } from "./label.fixture.js";
const assess = (c = gncLabelFixture()) => assessLabelCandidate(LabelImageCandidateSchema.parse(c));
it("keeps 3 dose-free headers, 15 numerical rows and 11 components without duplicated ingredient records", () => {
  const c = gncLabelFixture(), rows = c.formula!.columns[0]!.rows;
  expect(assess(c)).toEqual({ status: "candidate", codes: [] });
  expect(rows.filter(r => r.amount)).toHaveLength(15);
  expect(rows.filter(r => r.kind === "blend_component")).toHaveLength(11);
  expect(c.otherIngredients!.items).toHaveLength(7);
  expect(rows[4]!.name.text).toBe(rows[13]!.name.text);
  expect(labelFormulaStructure(c)!.columns[0]!.rows[14]!.parentRowIndex).toBe(13);
});
it.each([4, 14, 50, null])("rejects wrong/forward/missing group parent %s", parent => {
  const c = gncLabelFixture(); c.formula!.columns[0]!.rows[14]!.parentRowIndex = parent;
  expect(assess(c).codes).toContain("LABEL.PARENT_INVALID");
});
it("cannot use an ordinary nutrient as a group or attach a non-component to a parent", () => {
  const c = gncLabelFixture(), rows = c.formula!.columns[0]!.rows;
  rows[14]!.parentRowIndex = 0; rows[0]!.parentRowIndex = 4;
  expect(assess(c).codes).toContain("LABEL.PARENT_INVALID");
});
it("does not accept a dose attached to a header", () => {
  const c = gncLabelFixture(); c.formula!.columns[0]!.rows[4]!.amount = { text: "500 mg", evidence: "500 mg" };
  expect(assess(c).codes).toContain("LABEL.HEADER_VALUE_CONFLICT");
});
it.each(["unreadable", "not_declared", "not_applicable"] as const)("does not hide missing component dose as %s under a heading", status => {
  const c = gncLabelFixture(), row = c.formula!.columns[0]!.rows[5]!;
  row.amount = null; row.amountStatus = status;
  expect(assess(c).status).toBe("review");
});
it("a printed blend total can have undisclosed individual components without invented doses", () => {
  const c = gncLabelFixture(), rows = c.formula!.columns[0]!.rows;
  Object.assign(rows[4]!, { kind: "blend_total", amount: { text: "550 mg", evidence: "550 mg" }, amountStatus: "printed" });
  for (const row of rows.slice(5, 9)) { row.amount = null; row.amountStatus = "not_declared"; }
  expect(assess(c).status).toBe("candidate");
  rows[4]!.amount = null; rows[4]!.amountStatus = "not_declared";
  expect(assess(c).codes).toContain("LABEL.AMOUNT_MISSING");
});
it("empty groups, missing serving size, and model uncertainty remain reviewable", () => {
  const c = gncLabelFixture(); c.formula!.columns[0]!.rows.splice(14); c.formula!.servingSize = null;
  c.issues.push({ code: "METADATA_CONFLICT", detail: "3 and 12" });
  expect(assess(c).codes).toEqual(expect.arrayContaining(["LABEL.GROUP_EMPTY", "LABEL.FORMULA_INCOMPLETE", "LABEL.EVIDENCE_UNCERTAIN"]));
});
it("partial sections cannot bypass bad doses", () => {
  const c = gncLabelFixture(); c.otherIngredients = null; c.formula!.columns[0]!.rows = [c.formula!.columns[0]!.rows[0]!];
  c.ingredientsComplete = false;
  expect(assess(c).status).toBe("partial");
  c.formula!.columns[0]!.rows[0]!.amount = null;
  expect(assess(c).status).toBe("review");
});
it("new codec is strict, independently serializable, and not accepted as a legacy image result", () => {
  expect(VisionCandidateSchema.safeParse(gncLabelFixture()).success).toBe(false);
  expect(LabelImageCandidateSchema.safeParse({ ...gncLabelFixture(), codec: "vision-candidate/1" }).success).toBe(false);
  const schema = JSON.stringify(z.toJSONSchema(LabelTextWireSchema));
  expect(schema).toContain('"parentRowIndex"'); expect(schema).not.toContain('"start"');
});
it("blank fields, nonexistent complete sections, and allergen headings cannot count as ingredients", () => {
  const c = gncLabelFixture(); c.otherIngredients!.heading.text = "Contains:";
  expect(assess(c).codes).toContain("LABEL.INGREDIENT_HEADING_INVALID");
  for (const bad of ["Amount Per Serving", "Supplement Facts", "% Daily Value", "May contain milk"]) { c.otherIngredients!.heading.text = bad; expect(assess(c).codes).toContain("LABEL.INGREDIENT_HEADING_INVALID"); }
  for (const ok of ["Ingredients:", "Inactive Ingredients", "Other Ingredients (Capsule):", "Capsule ingredients:; Other ingredients:", "Oher Ingredients:", "Non-medicinal ingredients"]) { c.otherIngredients!.heading.text = ok; expect(assess(c).codes).not.toContain("LABEL.INGREDIENT_HEADING_INVALID"); }
  c.formula = null; expect(assess(c).codes).toContain("LABEL.COMPLETENESS_CONFLICT");
  c.otherIngredients!.items[0]!.text = " "; expect(LabelImageCandidateSchema.safeParse(c).success).toBe(false);
});
