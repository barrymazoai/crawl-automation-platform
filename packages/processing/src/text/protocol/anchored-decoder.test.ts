import { describe, expect, it } from "vitest";
import { decodeTextResponse } from "./anchored-decoder.js";
import { anchor, anchoredAnswer, anchoredInput, quoteAt } from "./anchored-test-helpers.js";

describe("decodeTextResponse anchored protocol", () => {
  it("converts local line anchors to exact absolute UTF-16 quotes within the selected range", () => {
    const { text: selection, wire } = anchoredAnswer();
    const prefix = "ignored 😀\n";
    const text = `${prefix}${selection}\nnot selected`;
    const input = anchoredInput(text, {
      range: { start: prefix.length, end: prefix.length + selection.length },
    });
    expect(decodeTextResponse(input, text, JSON.stringify(wire))).toEqual({
      schemaVersion: 2,
      formula: {
        servingSize: quoteAt(text, "Serving Size 1 Capsule"),
        nutrients: [
          {
            name: quoteAt(text, "Vitamin C"),
            amount: quoteAt(text, "10 mg"),
            dailyValue: quoteAt(text, "11%"),
          },
        ],
      },
      ingredients: {
        items: ["Rice flour", "cellulose"].map((value) => ({
          ...quoteAt(text, value),
          role: "other",
          parentNutrientIndex: null,
        })),
      },
    });
  });

  it("keeps wrapped ingredient whitespace exactly as printed", () => {
    const text = "Other Ingredients:\napple\ncider   vinegar";
    const wire = {
      formula: null,
      ingredients: {
        items: [
          {
            quote: { fromLine: 2, toLine: 3, text: "apple cider vinegar" },
            role: "other",
            parentNutrientIndex: null,
          },
        ],
      },
      excluded: [{ quote: anchor(1, "Other Ingredients:"), reason: "heading" }],
      issues: [],
    };
    const candidate = decodeTextResponse(anchoredInput(text), text, JSON.stringify(wire));
    expect(candidate.ingredients?.items[0]).toMatchObject(quoteAt(text, "apple\ncider   vinegar"));
  });

  it("accepts a blend component with its formula parent and absent amounts", () => {
    const text = "Herbal Blend\nGinger";
    const wire = {
      formula: {
        servingSize: null,
        nutrients: [{ name: anchor(1, "Herbal Blend"), amount: null, dailyValue: null }],
      },
      ingredients: {
        items: [{ quote: anchor(2, "Ginger"), role: "blend_component", parentNutrientIndex: 0 }],
      },
      excluded: [],
      issues: [],
    };
    expect(decodeTextResponse(anchoredInput(text), text, JSON.stringify(wire))).toMatchObject({
      formula: { servingSize: null, nutrients: [{ amount: null, dailyValue: null }] },
      ingredients: { items: [{ role: "blend_component", parentNutrientIndex: 0 }] },
    });
  });

  it.each([
    "not JSON",
    "null",
    "{}",
    '{"formula":null}',
    '{"formula":null,"ingredients":null,"excluded":[],"issues":[],"extra":true}',
  ])("reports malformed model output as TEXT.MODEL_SCHEMA: %s", (raw) => {
    expect(() => decodeTextResponse(anchoredInput("data"), "data", raw)).toThrow(
      expect.objectContaining({ code: "TEXT.MODEL_SCHEMA" }),
    );
  });

  it.each(["missing_text", "ambiguous_layout", "uncertain_role"] as const)(
    "refuses the model's %s issue",
    (issue) => {
      const { text, wire } = anchoredAnswer();
      wire.issues = [issue];
      expect(() => decodeTextResponse(anchoredInput(text), text, JSON.stringify(wire))).toThrow(
        expect.objectContaining({ code: "TEXT.INPUT_INCOMPLETE" }),
      );
    },
  );

  it("refuses an omitted printed field even when every supplied quote is valid", () => {
    const { text, wire } = anchoredAnswer();
    wire.formula = null;
    expect(() => decodeTextResponse(anchoredInput(text), text, JSON.stringify(wire))).toThrow(
      expect.objectContaining({ code: "TEXT.EXTRACTION_INCOMPLETE" }),
    );
  });

  it.each(["marketing", "noise", "heading"] as const)(
    "does not hide a nutrient using a %s exclusion",
    (reason) => {
      const text = "Vitamin C";
      const wire = {
        formula: null,
        ingredients: null,
        excluded: [{ quote: anchor(1, text), reason }],
        issues: [],
      };
      expect(() => decodeTextResponse(anchoredInput(text), text, JSON.stringify(wire))).toThrow(
        expect.objectContaining({ code: "TEXT.COVERAGE_UNCERTAIN" }),
      );
    },
  );

  it("rejects a nonexistent citation before accepting coverage", () => {
    const { text, wire } = anchoredAnswer();
    wire.excluded[0] = { quote: anchor(99, "Supplement Facts"), reason: "heading" };
    expect(() => decodeTextResponse(anchoredInput(text), text, JSON.stringify(wire))).toThrow(
      expect.objectContaining({ code: "TEXT.CITATION_INVALID" }),
    );
  });

  it.each([0, 99])("refuses an other ingredient with parent index %d", (parentNutrientIndex) => {
    const { text, wire } = anchoredAnswer();
    wire.ingredients = {
      items: [{ quote: anchor(4, "Rice flour"), role: "other", parentNutrientIndex }],
    };
    expect(() => decodeTextResponse(anchoredInput(text), text, JSON.stringify(wire))).toThrow(
      expect.objectContaining({ code: "TEXT.ROLE_INVALID" }),
    );
  });

  it("refuses a combined ingredient list even when the quote covers all the text", () => {
    const { text, wire } = anchoredAnswer();
    wire.ingredients = {
      items: [
        { quote: anchor(4, "Rice flour, cellulose"), role: "other", parentNutrientIndex: null },
      ],
    };
    expect(() => decodeTextResponse(anchoredInput(text), text, JSON.stringify(wire))).toThrow(
      expect.objectContaining({ code: "TEXT.INGREDIENT_BOUNDARY" }),
    );
  });
});

describe("decodeTextResponse legacy v1", () => {
  it("keeps legacy candidates readable without adding role fields", () => {
    const text = "Vitamin C";
    const candidate = { formula: null, ingredients: { items: [quoteAt(text, text)] } };
    const input = anchoredInput(text, { resultSchemaVersion: 1 });
    expect(decodeTextResponse(input, text, JSON.stringify(candidate))).toEqual(candidate);
  });

  it.each([
    [
      { formula: null, ingredients: { items: [{ text: "wrong", start: 0, end: 5 }] } },
      "TEXT.CITATION_INVALID",
    ],
    [{ formula: null, ingredients: { items: [] } }, "TEXT.MODEL_SCHEMA"],
  ])("refuses malformed or unfaithful legacy candidates", (candidate, code) => {
    const text = "Vitamin C";
    const input = anchoredInput(text, { resultSchemaVersion: 1 });
    expect(() => decodeTextResponse(input, text, JSON.stringify(candidate))).toThrow(
      expect.objectContaining({ code }),
    );
  });
});
