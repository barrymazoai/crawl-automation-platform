import { describe, expect, it } from "vitest";
import { simpleLabel, decodeSimple } from "../../testing/simple-label.js";
import { decodeDrug, drugLines, drugWire } from "../../testing/drug-label-fixture.js";

describe("derived structural coverage", () => {
  it.each(["Supplement Facts", "Nutrition Facts"])(
    "covers %s and value-anchored structures",
    (heading) => {
      expect(decodeSimple(simpleLabel({ heading })).codes).toEqual([]);
    },
  );
  it.each(["Zinc 5 mg", "Extra herb", "200 mg"])("still requires data %s", (missing) => {
    const fixture = simpleLabel();
    fixture.lines.push(missing);
    expect(decodeSimple(fixture).codes).toContain("LABEL.EXTRACTION_INCOMPLETE");
  });
  it("does not cover a serving value or another panel merely because a heading exists", () => {
    const fixture = simpleLabel();
    if (fixture.wire.formula) {
      fixture.wire.formula.servingsPerContainer = null;
    }
    expect(decodeSimple(fixture).codes).toContain("LABEL.EXTRACTION_INCOMPLETE");
    const second = simpleLabel();
    second.lines.push("Nutrition Facts");
    expect(decodeSimple(second).codes).toContain("LABEL.EXTRACTION_INCOMPLETE");
  });
  it("keeps Drug Facts strengths, Purpose and cited directions without inventing servings", () => {
    const lines = drugLines.map((line) => line.replace("lactose, sucrose", "lactose, and sucrose"));
    const result = decodeDrug(drugWire(), lines);
    expect(result.codes).toEqual([]);
    expect(result.candidate.formula?.servingSize).toBeNull();
    expect(result.candidate.formula?.columns[0]?.rows[0]?.amount?.text).toBe("30C HPUS");
    expect(decodeDrug(drugWire(), [...lines, "Belladonna 6X HPUS"]).codes).toContain(
      "LABEL.EXTRACTION_INCOMPLETE",
    );
  });
});
