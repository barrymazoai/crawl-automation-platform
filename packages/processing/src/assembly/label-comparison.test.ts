import { describe, expect, it } from "vitest";
import { labelCandidate } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import { compareLabelStructure } from "./label-comparison.js";

const source = (candidate = labelCandidate()) => ({ kind: "image" as const, candidate });
const column = (compared: ReturnType<typeof source>) =>
  defined(compared.candidate.formula?.columns[0]);

// Cases carried over from the former label comparison.
describe("label comparison", () => {
  it("identical structures match without merging equal group names", () => {
    expect(compareLabelStructure(source(), source())).toEqual({ status: "match", codes: [] });
  });

  it("a same-named but wrong parent stays unresolved", () => {
    const other = source();
    defined(column(other).rows[14]).parentRowIndex = 4;
    expect(compareLabelStructure(source(), other).status).toBe("unresolved");
  });

  it.each(["dose", "column", "component"])("a changed %s is a conflict", (kind) => {
    const other = source();
    const rows = column(other).rows;
    if (kind === "dose") {
      defined(defined(rows[14]).amount).text = "200 mg";
    }
    if (kind === "column") {
      defined(column(other).heading).text = "Per two servings";
    }
    if (kind === "component") {
      defined(rows[14]).name.text = "Different component";
    }
    expect(compareLabelStructure(source(), other).codes).toContain("LABEL.FORMULA_CONFLICT");
  });

  it("3 versus 12 stays a conflict, never pack-count arithmetic", () => {
    const other = source();
    defined(other.candidate.formula?.servingsPerContainer).text = "12";
    expect(compareLabelStructure(source(), other)).toEqual({
      status: "conflict",
      codes: ["LABEL.CONTAINER_COUNT_CONFLICT"],
    });
  });

  it("missing other ingredients and an empty formula are not matches", () => {
    const other = source();
    other.candidate.otherIngredients = null;
    expect(compareLabelStructure(source(), other).codes).toContain(
      "LABEL.OTHER_INGREDIENTS_CONFLICT",
    );
    other.candidate.formula = null;
    expect(compareLabelStructure(source(), other).status).toBe("unresolved");
  });

  it("does not erase trademark, punctuation or unit differences as a guess", () => {
    const other = source();
    defined(column(other).rows[4]).name.text = "FocusFuel Electrolyte Blend";
    expect(compareLabelStructure(source(), other).status).toBe("conflict");
  });
});
