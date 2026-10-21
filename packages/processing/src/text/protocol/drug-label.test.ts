import { describe, expect, it } from "vitest";
import { drugLines, drugWire, decodeDrug } from "../../testing/drug-label-fixture.js";
import { defined } from "../../testing/defined.js";
import { decodeLabelText } from "./label-decoder.js";
import { labelTextPrompt } from "./label-instructions.js";
import { simpleLabel } from "../../testing/simple-label.js";

describe("Drug Facts text protocol", () => {
  it("decodes an active semicolon clause followed by a bare inactive list", () => {
    const text =
      "Ingredients\n\nactive ingredient;in each lozenge;methol 5mg purposes antitussive;cough suppressant;/ oral anesthetic inactive organic brown rice syrup;organic cane syrup;and organic turmeric";
    const anchor = (line: number, value: string) => ({ fromLine: line, toLine: line, text: value });
    const wire = {
      codec: "label-extraction/1",
      formula: {
        drugFacts: null,
        servingSize: null,
        servingsPerContainer: null,
        columns: [
          {
            heading: anchor(3, "active ingredient;in each lozenge"),
            rows: [
              {
                kind: "nutrient",
                name: anchor(3, "methol"),
                amount: anchor(3, "5mg"),
                dailyValue: null,
                purpose: anchor(3, "antitussive;cough suppressant;/ oral anesthetic"),
                amountStatus: "printed",
                parentRowIndex: null,
              },
            ],
          },
        ],
      },
      otherIngredients: {
        heading: anchor(1, "Ingredients"),
        items: ["organic brown rice syrup", "organic cane syrup", "organic turmeric"].map((value) =>
          anchor(3, value),
        ),
      },
      formulaComplete: true,
      ingredientsComplete: true,
      exclusions: [
        { quote: anchor(3, "purposes"), reason: "heading" },
        { quote: anchor(3, "inactive"), reason: "heading" },
        { quote: anchor(3, "and"), reason: "noise" },
      ],
      issues: [],
    };
    expect(
      decodeLabelText({
        text,
        scope: { range: { start: 0, end: text.length } },
        response: JSON.stringify(wire),
        policyVersion: "label-text/6",
      }).codes,
    ).toEqual([]);
  });

  it("decodes a compressed active/inactive line and its isolated Ingredients heading", () => {
    const text =
      "Ingredients\n\nDrug classification: active ingredient in each lozenge menthol 5mg purposes antitussive inactive sucrose";
    const anchor = (line: number, value: string) => ({ fromLine: line, toLine: line, text: value });
    const wire = {
      codec: "label-extraction/1",
      formula: {
        drugFacts: null,
        servingSize: null,
        servingsPerContainer: null,
        columns: [
          {
            heading: anchor(3, "active ingredient"),
            rows: [
              {
                kind: "nutrient",
                name: anchor(3, "menthol"),
                amount: anchor(3, "5mg"),
                dailyValue: null,
                purpose: anchor(3, "antitussive"),
                amountStatus: "printed",
                parentRowIndex: null,
              },
            ],
          },
        ],
      },
      otherIngredients: { heading: anchor(3, "inactive"), items: [anchor(3, "sucrose")] },
      formulaComplete: true,
      ingredientsComplete: true,
      exclusions: [
        { quote: anchor(1, "Ingredients"), reason: "heading" },
        { quote: anchor(3, "Drug classification:"), reason: "metadata" },
        { quote: anchor(3, "in each lozenge"), reason: "metadata" },
        { quote: anchor(3, "purposes"), reason: "heading" },
      ],
      issues: [],
    };
    const decode = (policyVersion: string) =>
      decodeLabelText({
        text,
        scope: { range: { start: 0, end: text.length } },
        response: JSON.stringify(wire),
        policyVersion,
      });
    expect(decode("label-text/6").codes).toEqual([]);
    defined(wire.exclusions[2]).reason = "heading";
    expect(decode("label-text/6").codes).toEqual([]);
    expect(decode("label-text/5").codes).toContain("LABEL.COVERAGE_UNCERTAIN");
  });

  it("keeps bare inactive and purposes under Review on an ordinary label", () => {
    const fixture = simpleLabel();
    fixture.lines[6] = "inactive Cellulose, and Silica";
    const other = defined(fixture.wire.otherIngredients);
    other.heading.text = "inactive";
    const text = fixture.lines.join("\n");
    const decode = () =>
      decodeLabelText({
        text,
        scope: { range: { start: 0, end: text.length } },
        response: JSON.stringify(fixture.wire),
        policyVersion: "label-text/6",
      });
    expect(decode().codes).toContain("LABEL.INGREDIENT_HEADING_INVALID");
    fixture.lines.splice(6, 0, "purposes");
    other.heading.fromLine = 8;
    other.heading.toLine = 8;
    other.items.forEach((item) => {
      item.fromLine = 8;
      item.toLine = 8;
    });
    fixture.wire.exclusions.push({
      quote: { fromLine: 7, toLine: 7, text: "purposes" },
      reason: "heading",
    });
    const withPurpose = fixture.lines.join("\n");
    expect(
      decodeLabelText({
        text: withPurpose,
        scope: { range: { start: 0, end: withPurpose.length } },
        response: JSON.stringify(fixture.wire),
        policyVersion: "label-text/6",
      }).codes,
    ).toContain("LABEL.COVERAGE_UNCERTAIN");
  });

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

  it.each(["inactive", "Inactive ingredient:", "Inactive ingredients", "Inactive ingredient(s):"])(
    "accepts the printed Drug Facts inactive heading %s",
    (heading) => {
      const wire = drugWire();
      defined(wire.otherIngredients).heading.text = heading;
      const lines = drugLines.map((line, index) =>
        index === 10 ? line.replace("Inactive Ingredients:", heading) : line,
      );
      const result = decodeDrug(wire, lines);
      expect(result.codes).toEqual([]);
      expect(result.status).toBe("candidate");
    },
  );

  it.each(["Active ingredient(s):", "active ingredients", "Active:"])(
    "accepts the printed Drug Facts active heading %s",
    (heading) => {
      const wire = drugWire();
      defined(defined(defined(wire.formula).columns[0]).heading).text = heading;
      const lines = drugLines.map((line, index) => (index === 1 ? heading : line));
      expect(decodeDrug(wire, lines).codes).toEqual([]);
    },
  );

  it("accepts a cited Purposes column, Drug classification header and an active-row connector", () => {
    const wire = drugWire();
    const lines = [...drugLines];
    lines[2] = "Purposes antitussive;cough suppressant;/ oral anesthetic";
    lines[3] = "Arnica montana and 30C HPUS Relieves muscle pain";
    lines.push("Drug classification:");
    defined(wire.exclusions[0]).quote.text = defined(lines[2]);
    wire.exclusions.push(
      { quote: { fromLine: 4, toLine: 4, text: "and" }, reason: "noise" },
      { quote: { fromLine: 13, toLine: 13, text: "Drug classification:" }, reason: "metadata" },
    );
    expect(decodeDrug(wire, lines).codes).toEqual([]);
  });

  it("accepts an excluded Ingredients heading immediately before Inactive Ingredients", () => {
    const wire = drugWire();
    const lines = drugLines.map((line, index) =>
      index === 10 ? "Ingredients Inactive Ingredients: sucrose" : line,
    );
    defined(wire.otherIngredients).items = [{ fromLine: 11, toLine: 11, text: "sucrose" }];
    wire.exclusions.push({
      quote: { fromLine: 11, toLine: 11, text: "Ingredients" },
      reason: "heading",
    });
    expect(decodeDrug(wire, lines).codes).toEqual([]);
    wire.formula = null;
    const missingActive = decodeDrug(wire, lines);
    expect(missingActive.codes).not.toContain("LABEL.INGREDIENT_HEADING_INVALID");
    expect(missingActive.codes).toContain("LABEL.COMPLETENESS_CONFLICT");
    wire.formula = drugWire().formula;
    lines[10] = "Ingredients unrelated words Inactive Ingredients: sucrose";
    expect(decodeDrug(wire, lines).codes).toContain("LABEL.INGREDIENT_ROLE_INVALID");
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
