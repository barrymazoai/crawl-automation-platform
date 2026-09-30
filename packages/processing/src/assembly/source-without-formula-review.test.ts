import { LabelEvidencePolicySchema } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { labelCandidate } from "../testing/assembly-fixture.js";
import { drugWire } from "../testing/drug-label-fixture.js";
import { collectBoth, mergeSetup, signal, textReview } from "../testing/merge-fixture.js";

const code = "TEXT.LABEL_COVERAGE_UNCERTAIN";
const skipped = { id: "a-text", code: "LABEL_PRODUCT.SOURCE_WITHOUT_LABEL" };

function noFormula(issue = true) {
  return {
    codec: "label-extraction/1",
    formula: null,
    formulaComplete: false,
    ingredientsComplete: true,
    otherIngredients: {
      heading: { fromLine: 1, toLine: 1, text: "Ingredients" },
      items: [{ fromLine: 2, toLine: 2, text: "lactose" }],
    },
    exclusions: [
      "About this item",
      "Once Daily: A once daily capsule",
      "7-Day Pill Minder Included",
    ].map((text, index) => ({
      reason: "marketing",
      quote: { fromLine: index + 3, toLine: index + 3, text },
    })),
    issues: issue ? [{ code: "FORMULA_MISSING", detail: "No formula section is present." }] : [],
  };
}

async function reviewed(response = JSON.stringify(noFormula())) {
  const setup = await mergeSetup();
  const review = textReview(setup, code);
  review.candidate = { schema: "text-raw-response/1", value: { rawResponse: response } };
  return { ...setup, review };
}

describe("text coverage Reviews without a formula", () => {
  it.each([undefined, ...LabelEvidencePolicySchema.options])(
    "warns and collects a complete label under evidence policy %s",
    async (policy) => {
      const setup = await reviewed();
      if (policy) {
        setup.join.manifest.evidencePolicy = policy;
      } else {
        delete setup.join.manifest.evidencePolicy;
      }
      const original = structuredClone(setup.review);
      const record = await collectBoth(setup);
      expect(record.warnings).toEqual(expect.arrayContaining([skipped, { id: "a-text", code }]));
      expect(setup.records.get(setup.review.reviewId)).toEqual(original);
      expect(record.provenance.map((entry) => entry.id)).toEqual(["source-0"]);
    },
  );

  it("accepts formula null without requiring a FORMULA_MISSING issue", async () => {
    const setup = await reviewed(JSON.stringify(noFormula(false)));
    expect((await collectBoth(setup)).warnings).toContainEqual(skipped);
  });

  it.each(
    LabelEvidencePolicySchema.options.flatMap((policy) =>
      [false, true].map((missingIssue) => ({ policy, missingIssue })),
    ),
  )(
    "keeps formula-bearing coverage blocking under $policy (missing issue: $missingIssue)",
    async ({ policy, missingIssue }) => {
      const answer = drugWire();
      // Even a contradictory missing-formula issue must not hide the extracted formula.
      if (missingIssue) {
        answer.issues.push({ code: "FORMULA_MISSING", detail: "Contradictory model answer" });
      }
      const setup = await reviewed(JSON.stringify(answer));
      setup.join.manifest.evidencePolicy = policy;
      expect(await setup.assembly.run(setup.join, signal())).toMatchObject({
        status: "review",
        codes: [code],
      });
    },
  );

  it.each(["only source", "incomplete image", "unknown execution", "foreign Review"])(
    "still blocks when there is %s",
    async (mode) => {
      const setup = await reviewed();
      if (mode === "only source") {
        setup.join.manifest.sources = setup.join.manifest.sources.filter(
          ({ kind }) => kind === "text",
        );
        setup.join.states = setup.join.states.filter(({ id }) => id === setup.text.id);
      } else if (mode === "incomplete image") {
        const partial = labelCandidate();
        partial.formulaComplete = false;
        const image = setup.entries.find(({ kind }) => kind === "image");
        if (image) {
          image.candidate = partial;
          setup.deps.readSource.mockResolvedValue(image);
        }
      } else if (mode === "unknown execution") {
        setup.review.failure.executionFact = "unknown";
      } else {
        setup.review.failure.operationId = "another-operation";
      }
      expect(await setup.assembly.run(setup.join, signal())).toMatchObject({ status: "review" });
      expect(setup.registry.append).not.toHaveBeenCalled();
    },
  );

  it.each([
    "not json",
    "null",
    '{"formula":null}',
    JSON.stringify({ ...noFormula(), codec: "wrong" }),
  ])("does not infer no label from a malformed answer %s", async (response) => {
    const setup = await reviewed(response);
    expect(await setup.assembly.run(setup.join, signal())).toMatchObject({
      status: "review",
      codes: [code],
    });
  });

  it("keeps unrelated quality failures blocking even when the answer has no formula", async () => {
    const setup = await reviewed();
    setup.review.failure.code = "TEXT.LABEL_EVIDENCE_UNCERTAIN";
    expect(await setup.assembly.run(setup.join, signal())).toMatchObject({
      status: "review",
      codes: ["TEXT.LABEL_EVIDENCE_UNCERTAIN"],
    });
  });
});
