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

const dherbsRoot = new URL(
  "../../../../../tools/diag-corpus/round9/dherbs-capsules/",
  import.meta.url,
);
type StoredReview = {
  failure: { evidenceKey: string };
  candidate: { value: { rawResponse: string } };
};
const dherbsReviews: StoredReview[] = JSON.parse(
  readFileSync(new URL("reviews.json", dherbsRoot), "utf8"),
);
const dherbsCases = [
  { name: "garcinia", prefix: "chl-fe4b6543", count: 1, reclassified: true },
  { name: "anti-v", prefix: "chl-0f30d7ce", count: 19, reclassified: true },
  { name: "detox", prefix: "chl-75407496", count: 10, reclassified: true },
  { name: "female-breast", prefix: "chl-1a92d8cb", count: 10, reclassified: true },
  { name: "anti-aging", prefix: "chl-5d810c9f", count: 6, reclassified: true },
  { name: "male-hormonal", prefix: "chl-f8e9f187", count: 20, reclassified: true },
  { name: "sea-moss-combo", prefix: "chl-eab1e727", count: 3, reclassified: false },
] as const;

function dherbsCase(prefix: string) {
  const review = dherbsReviews.find((item) => item.failure?.evidenceKey?.includes(prefix));
  if (!review) {
    throw new Error(`Missing Dherbs Review ${prefix}`);
  }
  const basename = review.failure.evidenceKey.split("/").at(-1);
  if (!basename) {
    throw new Error(`Missing evidence basename for ${prefix}`);
  }
  const intent = JSON.parse(readFileSync(new URL(basename, dherbsRoot), "utf8"));
  const core = JSON.parse(readFileSync(new URL(`core/${basename}`, dherbsRoot), "utf8"));
  return {
    response: review.candidate.value.rawResponse as string,
    text: core.text as string,
    range: intent.input.range,
  };
}

describe("Dherbs no-Facts Ingredients lists", () => {
  it.each(dherbsCases)(
    "accepts $name as an ingredients-only text label",
    ({ prefix, count, reclassified }) => {
      const { response, text, range } = dherbsCase(prefix);
      const decoded = decodeLabelText({
        scope: { range },
        text,
        response,
        policyVersion: "label-text/6",
      });
      expect(decoded.status).toBe("partial");
      expect(decoded.codes).toEqual([]);
      expect(decoded.candidate.formula).toBeNull();
      expect(decoded.candidate.otherIngredients?.items).toHaveLength(count);
      expect(decoded.candidate.ingredientsComplete).toBe(true);
      expect(
        decoded.warnings
          .map((warning) => warning.code)
          .includes("LABEL.FORMULA_IS_INGREDIENT_LIST"),
      ).toBe(reclassified);
      expect(
        assessLabelCandidate(
          TextCandidateV3Schema.parse({ ...decoded.candidate, schemaVersion: 3 }),
        ).status,
      ).toBe("partial");
    },
  );

  it("keeps a Facts heading, serving-size line, or printed row amount on the formula Review path", () => {
    const source = dherbsCase("chl-75407496");
    for (const line of [
      "Supplement Facts",
      "Nutrition Info",
      "Amount Per Serving",
      "Serving Size 3 Capsules",
    ]) {
      const text = `${source.text}\n${line}`;
      const decoded = decodeLabelText({
        scope: { range: { start: 0, end: text.length } },
        text,
        response: source.response,
        policyVersion: "label-text/6",
      });
      expect(decoded.candidate.formula).not.toBeNull();
      expect(decoded.status).toBe("review");
    }
    const wire = JSON.parse(source.response);
    wire.formula.columns[0].rows[0].amount = { fromLine: 1, toLine: 1, text: "$26.95" };
    wire.formula.columns[0].rows[0].amountStatus = "printed";
    const printed = decodeLabelText({
      scope: { range: source.range },
      text: source.text,
      response: JSON.stringify(wire),
      policyVersion: "label-text/6",
    });
    expect(printed.candidate.formula).not.toBeNull();
  });

  it("keeps an incompletely cited Ingredients list in Review", () => {
    const source = dherbsCase("chl-1a92d8cb");
    const wire = JSON.parse(source.response);
    wire.otherIngredients.items.pop();
    const decoded = decodeLabelText({
      scope: { range: source.range },
      text: source.text,
      response: JSON.stringify(wire),
      policyVersion: "label-text/6",
    });
    expect(decoded.candidate.formula).not.toBeNull();
    expect(decoded.status).toBe("review");
  });
});
