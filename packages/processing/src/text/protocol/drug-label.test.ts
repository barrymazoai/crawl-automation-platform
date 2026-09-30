import { describe, expect, it } from "vitest";
import { drugLines, drugWire, decodeDrug } from "../../testing/drug-label-fixture.js";
import { defined } from "../../testing/defined.js";
import { decodeLabelText } from "./label-decoder.js";
import { labelTextPrompt } from "./label-instructions.js";

describe("Drug Facts text protocol", () => {
  it("keeps strengths and Purpose as exact quotes without inventing serving metadata", () => {
    const result = decodeDrug();
    expect(result.status).toBe("candidate");
    expect(result.codes).toEqual([]);
    expect(result.candidate.formula?.servingSize).toBeNull();
    const row = defined(defined(result.candidate.formula?.columns[0]).rows[0]);
    expect(row.amount?.text).toBe("30C HPUS");
    expect(row.purpose?.text).toBe("Relieves muscle pain");
    expect(row.purpose && drugLines.join("\n").slice(row.purpose.start, row.purpose.end)).toBe(
      "Relieves muscle pain",
    );
    expect(result.candidate.otherIngredients?.items.map((item) => item.text)).toEqual([
      "lactose",
      "sucrose",
    ]);
  });

  it.each(["1X HPUS 7%", "200CK HPUS 0.85 g", "6C HPUS (0.28 mg)"])(
    "keeps strength %s verbatim",
    (strength) => {
      const wire = drugWire();
      const row = wire.formula?.columns[0]?.rows[0];
      if (row?.amount) {
        row.amount.text = strength;
      }
      const lines = drugLines.map((line) => line.replace("30C HPUS", strength));
      expect(decodeDrug(wire, lines).codes).toEqual([]);
    },
  );

  it("does not accept a dropped Purpose or allow it to become a footnote", () => {
    const wire = drugWire();
    const row = wire.formula?.columns[0]?.rows[0];
    const purpose = row?.purpose;
    if (row) {
      delete row.purpose;
    }
    expect(decodeDrug(wire).codes).toContain("LABEL.EXTRACTION_INCOMPLETE");
    if (purpose) {
      wire.exclusions.push({ quote: purpose, reason: "footnote" });
    }
    expect(decodeDrug(wire).codes).toContain("LABEL.COVERAGE_UNCERTAIN");
  });

  it("does not let a Directions exclusion consume the inactive ingredients", () => {
    const wire = drugWire();
    wire.exclusions.push({
      reason: "directions",
      quote: {
        fromLine: 9,
        toLine: 11,
        text: drugLines.slice(8, 11).join("\n"),
      },
    });
    expect(decodeDrug(wire).codes).toContain("LABEL.COVERAGE_UNCERTAIN");
  });

  it("rejects a second panel and unrecognized excluded material", () => {
    expect(decodeDrug(drugWire(), [...drugLines, "Supplement Facts"]).codes).toContain(
      "LABEL.FORMULA_INCOMPLETE",
    );
    const wire = drugWire();
    wire.exclusions.push({
      quote: { fromLine: 13, toLine: 13, text: "Premium product" },
      reason: "metadata",
    });
    expect(decodeDrug(wire, [...drugLines, "Premium product"]).codes).toContain(
      "LABEL.COVERAGE_UNCERTAIN",
    );
  });

  it.each([
    "The letters HPUS indicate that this ingredient is officially included in the Homeopathic Pharmacopeia of the United States.",
    'The letter "HPUS" indicate that the component in this product is officially monographed in the Homeopathic Pharmacopoeia of the United States.',
    "(contains less than 10⁻¹⁴ mg atropine alkaloids)",
  ])("retains the printed homeopathic note: %s", (note) => {
    const wire = drugWire();
    defined(wire.exclusions[1]).quote.text = note;
    const lines = drugLines.map((line, index) => (index === 4 ? note : line));
    expect(decodeDrug(wire, lines).codes).toEqual([]);
  });

  it("accepts a separate Questions? heading and its body", () => {
    const wire = drugWire();
    const question = defined(wire.exclusions.at(-1));
    question.quote = { fromLine: 12, toLine: 13, text: "Questions?\nCall the manufacturer" };
    expect(
      decodeDrug(wire, [...drugLines.slice(0, 11), "Questions?", "Call the manufacturer"]).codes,
    ).toEqual([]);
  });

  it("rejects inactive ingredient items taken from a later Questions section", () => {
    const wire = drugWire();
    defined(wire.otherIngredients).items.push({
      fromLine: 12,
      toLine: 12,
      text: "Call the manufacturer",
    });
    expect(decodeDrug(wire).codes).toContain("LABEL.INGREDIENT_ROLE_INVALID");
  });

  it("only considers facts headings within the task's selected range", () => {
    const prefix = "Supplement Facts\nA separate document\n";
    const text = prefix + drugLines.join("\n");
    const result = decodeLabelText({
      text,
      response: JSON.stringify(drugWire()),
      scope: { range: { start: prefix.length, end: text.length } },
      policyVersion: "label-text/5",
    });
    expect(result.codes).toEqual([]);
  });

  it("preserves /4 instructions and rejects new fields under old policy versions", () => {
    const text = drugLines.join("\n");
    const scope = { range: { start: 0, end: text.length } };
    expect(labelTextPrompt(scope, text, "label-text/4").split('{"lines"')[0]).not.toContain(
      "Drug Facts",
    );
    expect(labelTextPrompt(scope, text, "label-text/5")).toContain("formula.drugFacts");
    expect(() =>
      decodeLabelText({
        scope,
        text,
        response: JSON.stringify(drugWire()),
        policyVersion: "label-text/4",
      }),
    ).toThrow();
  });
});
