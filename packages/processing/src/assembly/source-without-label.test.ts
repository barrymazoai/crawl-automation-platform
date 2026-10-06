import { describe, expect, it } from "vitest";
import { LabelEvidencePolicySchema } from "@crawl-automation/v3-contracts";
import { labelCandidate } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import {
  collectBoth,
  images,
  merge,
  mergeSetup,
  signal,
  textReview,
} from "../testing/merge-fixture.js";
import { agreementCandidate } from "./label-agreement-fixture.js";

const missingCode = "TEXT.LABEL_CORE_MISSING";
const skipped = { id: "a-text", code: "LABEL_PRODUCT.SOURCE_WITHOUT_LABEL" };

describe("assembly sources without labels", () => {
  it("collects two agreeing images despite an empty page Review, preserving both warning codes", async () => {
    const setup = await mergeSetup([
      agreementCandidate(),
      agreementCandidate("Vitamin D (as D3 cholecalciferol)"),
    ]);
    const review = textReview(setup, missingCode);
    const record = await collectBoth(setup);

    expect(record.warnings).toEqual(
      expect.arrayContaining([
        skipped,
        { id: setup.text.id, code: missingCode },
        { id: "source-1", code: "LABEL_PRODUCT.SOURCE_WORDING_DIFFERS" },
      ]),
    );
    expect(record.formula?.columns[0]?.rows).toHaveLength(2);
    expect(record.provenance.map((entry) => entry.id)).toEqual(["source-0", "source-1"]);
    expect(setup.records.get(review.reviewId)).toEqual(review);
    expect(setup.records.size).toBe(1);
    expect(setup.deps.readSource.mock.calls.every(([source]) => source.id !== setup.text.id)).toBe(
      true,
    );
  });

  it.each([undefined, ...LabelEvidencePolicySchema.options])(
    "applies the missing-label exception under evidence policy %s",
    async (evidencePolicy) => {
      const setup = await mergeSetup([labelCandidate(), labelCandidate()]);
      if (evidencePolicy) {
        setup.join.manifest.evidencePolicy = evidencePolicy;
      } else {
        delete setup.join.manifest.evidencePolicy;
      }
      textReview(setup, missingCode);
      const outcome = await setup.assembly.run(setup.join, signal());
      expect(outcome.status).toBe("ready");
      const { output } = await setup.assembly.inspectReady(
        setup.join,
        outcome.evidenceKey,
        signal(),
      );
      expect(output.result).toMatchObject({ status: "ready", codes: [] });
      expect(output.result.warnings).toContainEqual(skipped);
    },
  );

  it("keeps the original Review code when the empty page is the only source", async () => {
    const setup = await mergeSetup();
    setup.join.manifest.sources = setup.join.manifest.sources.filter(
      (source) => source.kind === "text",
    );
    setup.join.states = setup.join.states.filter((state) => state.id === setup.text.id);
    textReview(setup, missingCode);
    const outcome = await setup.assembly.run(setup.join, signal());
    expect(outcome).toMatchObject({
      status: "review",
      codes: expect.arrayContaining([missingCode]),
    });
    expect(setup.registry.append).not.toHaveBeenCalled();
    expect(
      merge(setup, [], [{ id: setup.text.id, code: missingCode, verifiedExecuted: true }]),
    ).toMatchObject({ warnings: [] });
  });

  it.each([
    "TEXT.LABEL_COVERAGE_UNCERTAIN",
    "TEXT.CITATION_INVALID",
    "TEXT.LABEL_INGREDIENT_BOUNDARY",
    "TEXT.LABEL_COMPLETENESS_CONFLICT",
    "TEXT.LABEL_FORMULA_INCOMPLETE",
    "TEXT.SOURCE_CONFLICT",
  ])("keeps a required text quality Review blocking under /1: %s", async (code) => {
    const setup = await mergeSetup([labelCandidate(), labelCandidate()]);
    textReview(setup, code);
    expect(await setup.assembly.run(setup.join, signal())).toMatchObject({
      status: "review",
      codes: [code],
    });
    expect(setup.registry.append).not.toHaveBeenCalled();
    expect(
      merge(setup, images(setup), [{ id: setup.text.id, code, verifiedExecuted: true }]).warnings,
    ).not.toContainEqual(skipped);
  });

  it("does not excuse an absent label when the other source is incomplete", async () => {
    const partial = labelCandidate();
    partial.formulaComplete = false;
    const setup = await mergeSetup([partial]);
    const result = merge(setup, images(setup), [
      { id: setup.text.id, code: missingCode, verifiedExecuted: true },
    ]);
    expect(result.status).toBe("review");
    expect(result.codes).toContain(missingCode);
    expect(result.warnings).not.toContainEqual(skipped);
  });

  it("does not treat an unconfirmed model execution as an empty label", async () => {
    const setup = await mergeSetup();
    const review = textReview(setup, missingCode);
    review.failure.executionFact = "unknown";
    expect(await setup.assembly.run(setup.join, signal())).toMatchObject({
      status: "review",
      codes: [missingCode],
    });
  });

  it.each(["missing", "foreign"])("keeps %s Review evidence blocking", async (mode) => {
    const setup = await mergeSetup();
    const review = textReview(setup, missingCode);
    if (mode === "missing") {
      setup.records.delete(review.reviewId);
    } else {
      review.failure.operationId = "foreign-operation";
    }
    expect(await setup.assembly.run(setup.join, signal())).toMatchObject({
      status: "review",
      codes: [
        mode === "missing" ? "LABEL_PRODUCT.REVIEW_UNVERIFIED" : "LABEL_PRODUCT.IDENTITY_CONFLICT",
      ],
    });
  });

  it("still blocks conflicting complete images when a page has no label", async () => {
    const conflicting = agreementCandidate();
    defined(conflicting.formula?.columns[0]?.rows[0]?.amount).text = "999 mcg";
    const setup = await mergeSetup([agreementCandidate(), conflicting]);
    textReview(setup, missingCode);
    expect(await setup.assembly.run(setup.join, signal())).toMatchObject({
      status: "review",
      codes: ["LABEL_PRODUCT.FORMULA_CONFLICT"],
    });
  });
});
