import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessLabelCandidate, TextCandidateV3Schema } from "@crawl-automation/v3-contracts";
import { decodeDrug } from "../../testing/drug-label-fixture.js";
import { decodeLabelText } from "./label-decoder.js";

const source = new URL("../../../../../tools/diag-corpus/round7/B078SD9ZY5/", import.meta.url);
const document = JSON.parse(readFileSync(new URL("page.document.json", source), "utf8"));
const intent = JSON.parse(readFileSync(new URL("page.intent.json", source), "utf8"));
const result = JSON.parse(readFileSync(new URL("page.result.json", source), "utf8"));
const decode = (response: string) =>
  decodeLabelText({
    scope: { range: intent.input.range },
    text: document.text,
    response,
    policyVersion: intent.input.policyVersion,
  });

describe("undosed Ingredients paragraph", () => {
  it("keeps the actual B078SD9ZY5 model answer as an ingredient-only source", () => {
    const decoded = decode(result.rawResponse);
    expect(decoded.candidate.formula).toBeNull();
    expect(decoded.candidate.ingredientParagraphReclassified).toBeUndefined();
    expect(decoded.candidate.otherIngredients?.items).toHaveLength(24);
    expect(decoded.codes).toEqual([]);
  });

  it("corrects a 24-row formula projection of that same page source", () => {
    const wire = JSON.parse(result.rawResponse);
    const items = wire.otherIngredients.items;
    wire.formula = {
      drugFacts: null,
      servingSize: null,
      servingsPerContainer: null,
      columns: [
        {
          heading: null,
          rows: items.map((name: unknown) => ({
            kind: "nutrient",
            name,
            amount: null,
            dailyValue: null,
            purpose: null,
            amountStatus: "not_declared",
            parentRowIndex: null,
          })),
        },
      ],
    };
    wire.otherIngredients = null;
    wire.ingredientsComplete = false;
    const decoded = decode(JSON.stringify(wire));
    expect(decoded.candidate.formula).toBeNull();
    expect(decoded.candidate.ingredientParagraphReclassified).toBe(true);
    expect(decoded.candidate.otherIngredients?.heading.text).toBe("Ingredients");
    expect(decoded.candidate.otherIngredients?.items).toHaveLength(24);
    expect(decoded.candidate.otherIngredients?.items[4]?.text).toBe(
      "Eggshell Membrane Collagen Amino Acids: Alanine",
    );
    expect(decoded.warnings.map((warning) => warning.code)).toContain(
      "LABEL.FORMULA_IS_INGREDIENT_LIST",
    );
    expect(decoded.codes).toEqual([]);
    expect(decoded.status).toBe("partial");
    const stored = TextCandidateV3Schema.parse({ ...decoded.candidate, schemaVersion: 3 });
    expect(assessLabelCandidate(stored).warnings.map((warning) => warning.code)).toContain(
      "LABEL.FORMULA_IS_INGREDIENT_LIST",
    );
  });

  it("keeps an active-ingredient drug source on its existing formula path", () => {
    expect(decodeDrug().candidate.formula).not.toBeNull();
  });
});
