import { describe, expect, it } from "vitest";
import { drugWire } from "../testing/drug-label-fixture.js";
import { simpleImage } from "../testing/simple-label.js";
import { collectBoth, images, merge, mergeSetup, reviewOf } from "../testing/merge-fixture.js";
import { defined } from "../testing/defined.js";
import { visionFingerprint } from "../testing/label-sources.js";
import { sourceReviewFailure } from "./source-review.js";
import type { LabelImageCandidate } from "@crawl-automation/v3-contracts";

function frontImage(): LabelImageCandidate {
  return {
    ...simpleImage(),
    formula: null,
    otherIngredients: null,
    formulaComplete: false,
    ingredientsComplete: false,
    issues: [{ code: "FORMULA_MISSING", detail: "Front panel only" }],
  };
}

async function siblingReview(candidate = frontImage()) {
  const setup = await mergeSetup([simpleImage(), candidate], simpleImage());
  setup.join.manifest.evidencePolicy = "label-image-first/6";
  const source = defined(setup.join.manifest.sources[1]);
  if (source.kind !== "image") {
    throw new Error("Expected image fixture");
  }
  const review = reviewOf(setup, {
    id: "partial-image",
    code: "VISION.LABEL_CORE_MISSING",
    operationId: source.task.input.operationId,
    inputFingerprint: visionFingerprint(source.task),
    stage: "codex.vision",
  });
  review.candidate = { schema: "label-extraction/1", value: JSON.parse(JSON.stringify(candidate)) };
  setup.records.set(review.reviewId, review);
  setup.join.states[1] = { id: source.id, status: "review", reviewId: review.reviewId };
  return { setup, source, review };
}

describe("complete labels and incomplete siblings under /6", () => {
  it("collects and cold-reads a complete image with a verified front-panel Review", async () => {
    const { setup, source } = await siblingReview();
    const record = await collectBoth(setup);
    expect(record.evidencePolicy).toBe("label-image-first/6");
    expect(record.warnings).toContainEqual({ id: source.id, code: "VISION.LABEL_CORE_MISSING" });
  });
  it("collects Drug Facts beside a front panel without requiring servings or Daily Values", async () => {
    const drug = simpleImage(drugWire());
    const setup = await mergeSetup([drug, frontImage()], drug);
    setup.join.manifest.evidencePolicy = "label-image-first/6";
    const record = await collectBoth(setup);
    expect(record.formula?.drugFacts?.text).toBe("Drug Facts");
    expect(record.formula?.servingSize).toBeNull();
    expect(record.formula?.columns[0]?.rows[0]?.amount?.text).toBe("30C HPUS");
  });
  it("preserves historical /3 and /5 decisions", async () => {
    for (const version of ["label-image-first/3", "label-image-first/5"] as const) {
      const { setup } = await siblingReview();
      setup.join.manifest.evidencePolicy = version;
      expect((await setup.assembly.run(setup.join, new AbortController().signal)).status).toBe(
        "review",
      );
    }
  });
  it("also warns for a registered incomplete sibling and a complete text fallback", async () => {
    const setup = await mergeSetup([frontImage()], simpleImage());
    setup.join.manifest.evidencePolicy = "label-image-first/6";
    const record = await collectBoth(setup);
    expect(record.formula?.servingSize?.citation.kind).toBe("text");
    expect(
      record.warnings.some(
        (warning) => warning.code === "LABEL_PRODUCT.INCOMPLETE_IMAGE_NOT_SELECTED",
      ),
    ).toBe(true);
  });
  it.each([
    "VISION.LABEL_FORMULA_INCOMPLETE",
    "VISION.LABEL_INGREDIENTS_INCOMPLETE",
    "VISION.LABEL_AMOUNT_UNREADABLE",
    "VISION.LABEL_EVIDENCE_UNCERTAIN",
  ])("warns for %s with retained candidate", async (code) => {
    const { setup, source, review } = await siblingReview();
    review.failure.code = code;
    const record = await collectBoth(setup);
    expect(record.warnings).toContainEqual({ id: source.id, code });
  });
  it.each(["dose", "ingredient"])(
    "blocks readable conflicting %s in a partial image",
    async (kind) => {
      const partial = simpleImage();
      partial.formulaComplete = false;
      if (kind === "dose") {
        defined(defined(partial.formula?.columns[0]?.rows[0]).amount).text = "999 mg";
      } else {
        defined(partial.otherIngredients?.items[0]).text = "Unlisted herb";
      }
      const { setup, source, review } = await siblingReview(partial);
      review.failure.code = "VISION.LABEL_FORMULA_INCOMPLETE";
      const failure = await sourceReviewFailure(setup.deps, source, {
        input: setup.join,
        reviewId: review.reviewId,
      });
      const result = merge(
        setup,
        setup.entries.filter((entry) => entry.id !== source.id),
        [failure],
      );
      expect(result.codes).toContain(
        kind === "dose" ? "LABEL_PRODUCT.FORMULA_CONFLICT" : "LABEL_PRODUCT.INGREDIENTS_CONFLICT",
      );
      expect(merge(setup).status).toBe("review");
    },
  );
  it.each(["unknown", "missing-answer", "missing-receipt", "wrong-variant"])(
    "blocks %s",
    async (kind) => {
      const { setup, review } = await siblingReview();
      if (kind === "unknown") {
        review.failure.executionFact = "unknown";
      }
      if (kind === "missing-answer") {
        review.candidate = null;
      }
      if (kind === "missing-receipt") {
        review.failure.evidenceKey = "";
      }
      if (kind === "wrong-variant") {
        review.observation = { ...defined(review.observation), variantId: "other-flavor" };
      }
      expect((await setup.assembly.run(setup.join, new AbortController().signal)).status).toBe(
        "review",
      );
    },
  );
  it("blocks ambiguity, complete-image conflicts and absence of any complete label", async () => {
    const { setup, review } = await siblingReview({
      ...frontImage(),
      issues: [{ code: "AMBIGUOUS", detail: "Two variants" }],
    });
    expect((await setup.assembly.run(setup.join, new AbortController().signal)).status).toBe(
      "review",
    );
    review.candidate = {
      schema: "label-extraction/1",
      value: JSON.parse(JSON.stringify(frontImage())),
    };
    const other = simpleImage();
    defined(defined(other.formula?.columns[0]?.rows[0]).amount).text = "70 mg";
    const conflicting = await mergeSetup([simpleImage(), other], simpleImage());
    conflicting.join.manifest.evidencePolicy = "label-image-first/6";
    expect(merge(conflicting).codes).toContain("LABEL_PRODUCT.FORMULA_CONFLICT");
    expect(
      merge(setup, images(setup).slice(1), [{ id: setup.text.id, code: "TEXT.LABEL_CORE_MISSING" }])
        .status,
    ).toBe("review");
  });
});
