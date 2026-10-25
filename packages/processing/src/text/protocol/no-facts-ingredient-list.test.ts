import type { LabelTextCandidate } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { exclusionCodes } from "./label-exclusions.js";
import { noFactsEvidence, normalizeNoFactsIngredientList } from "./no-facts-ingredient-list.js";

type Quote = { text: string; start: number; end: number };

function quote(text: string, value: string, from = 0): Quote {
  const start = text.indexOf(value, from);
  if (start < 0) {
    throw new Error(`Missing quote: ${value}`);
  }
  return { text: value, start, end: start + value.length };
}

function candidate(text: string, name: string): LabelTextCandidate {
  return {
    codec: "label-extraction/1",
    formula: null,
    otherIngredients: { heading: quote(text, "Ingredients"), items: [quote(text, name)] },
    formulaComplete: false,
    ingredientsComplete: true,
    issues: [],
    exclusions: [],
  };
}

function formulaRow(name: Quote): NonNullable<LabelTextCandidate["formula"]> {
  return {
    drugFacts: null,
    servingSize: null,
    servingsPerContainer: null,
    columns: [
      {
        heading: null,
        rows: [
          {
            kind: "nutrient",
            name,
            amount: null,
            dailyValue: null,
            purpose: null,
            amountStatus: "not_declared",
            parentRowIndex: null,
          },
        ],
      },
    ],
  };
}

function excluded(text: string, item: LabelTextCandidate, value: string): string[] {
  const exclusion = { reason: "metadata" as const, quote: quote(text, value) };
  return exclusionCodes({
    candidate: { ...item, exclusions: [exclusion] },
    text,
    policyVersion: "label-text/6",
  });
}

describe("complete no-Facts Ingredients list", () => {
  it("allows page content outside its cited list even when it mentions 500 mg", () => {
    const note = 'The vegan capsules are "0" size. Capsules hold about 500 mg.';
    const text = `Ingredients\nGOTU KOLA LEAF\n${note}`;
    expect(excluded(text, candidate(text, "GOTU KOLA LEAF"), note)).toEqual([]);
  });

  it("keeps Facts pages and an uncited ingredient gap on the coverage Review path", () => {
    const note = 'The vegan capsules are "0" size. Capsules hold about 500 mg.';
    const facts = `Supplement Facts\nIngredients\nGOTU KOLA LEAF\n${note}`;
    expect(excluded(facts, candidate(facts, "GOTU KOLA LEAF"), note)).toEqual([
      "LABEL.COVERAGE_UNCERTAIN",
    ]);
    const gap = `Ingredients\nGOTU KOLA LEAF, OMITTED HERB, GINKGO LEAF\n${note}`;
    const incomplete = candidate(gap, "GOTU KOLA LEAF");
    incomplete.otherIngredients?.items.push(quote(gap, "GINKGO LEAF"));
    expect(excluded(gap, incomplete, note)).toEqual(["LABEL.COVERAGE_UNCERTAIN"]);
  });

  it("treats 80% within the cited Pea Protein name as a name, not a dose", () => {
    const name = "PEA PROTEIN 80% ISOLATE POWDER (80% PROTEIN CONTENT)";
    const text = `Ingredients\n${name}`;
    const item = candidate(text, name);
    item.formula = formulaRow(quote(text, name));
    expect(noFactsEvidence(item, text, { start: 0, end: text.length })).toBe(true);
    normalizeNoFactsIngredientList(item, text, { start: 0, end: text.length });
    expect(item.formula).toBeNull();
  });

  it("keeps a percent in a nonmatching formula quote as a printed dose", () => {
    const name = "PEA PROTEIN 80% ISOLATE POWDER (80% PROTEIN CONTENT)";
    const text = `Other 80%\nIngredients\n${name}`;
    const item = candidate(text, name);
    item.formula = formulaRow(quote(text, "Other 80%"));
    expect(noFactsEvidence(item, text, { start: 0, end: text.length })).toBe(false);
  });

  it("moves the cited heading to a second consecutive Ingredients heading", () => {
    const text = "Ingredients\nIngredients:\nLUNGWORT LEAF";
    const item = candidate(text, "LUNGWORT LEAF");
    normalizeNoFactsIngredientList(item, text, { start: 0, end: text.length });
    expect(item.otherIngredients?.heading).toEqual(quote(text, "Ingredients:", 1));
  });

  it("does not move the heading past words between two headings", () => {
    const text = "Ingredients\nExtra details\nIngredients\nLUNGWORT LEAF";
    const item = candidate(text, "LUNGWORT LEAF");
    normalizeNoFactsIngredientList(item, text, { start: 0, end: text.length });
    expect(item.otherIngredients?.heading).toEqual(quote(text, "Ingredients"));
  });
});
