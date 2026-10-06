import { describe, expect, it } from "vitest";
import {
  LabelCollectedProductSchema,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { labelCandidate, visionFingerprint } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import {
  b12Text,
  collectBoth,
  images,
  merge,
  mergeSetup,
  reviewOf,
  rowsOf,
  textReview,
} from "../testing/merge-fixture.js";
import { mergeLabelProduct } from "./label-merge.js";

// Cases carried over from the former image-first label policy tests (/3, /4 and /5).
describe("label merge fallback policies", () => {
  it("/4 blocks an exact nutrient number disagreement instead of trusting complete=true", async () => {
    const text = labelCandidate();
    defined(defined(rowsOf(text)[1]).amount).text = "999 g";
    const setup = await mergeSetup([labelCandidate()], text);
    setup.join.manifest.evidencePolicy = "label-image-first/4";
    expect(merge(setup).codes).toContain("LABEL_PRODUCT.SOURCE_NUMERIC_CONFLICT");
    setup.join.manifest.evidencePolicy = "label-image-first/3";
    const record = await collectBoth(setup);
    expect(
      LabelCollectedProductSchema.safeParse({ ...record, evidencePolicy: "label-image-first/4" })
        .success,
    ).toBe(false);
  });

  it("/4 keeps the image's B12 grouping; not every text difference blocks", async () => {
    const setup = await mergeSetup([labelCandidate()], b12Text());
    setup.join.manifest.evidencePolicy = "label-image-first/4";
    expect(merge(setup).status).toBe("ready");
  });

  it("/4 excludes a verifiably defective image and keeps the complete text fallback", async () => {
    const candidate = labelCandidate();
    const rows = rowsOf(candidate);
    const parent = defined(rows[4]);
    parent.kind = "blend_total";
    parent.amount = { text: "100 mg", evidence: "100 mg" };
    parent.amountStatus = "printed";
    const row = defined(rows[5]);
    row.name.evidence = `90% ${row.name.text}`;
    row.amount = null;
    row.amountStatus = "not_declared";
    const setup = await mergeSetup([candidate]);
    setup.join.manifest.evidencePolicy = "label-image-first/4";
    const record = await collectBoth(setup);
    expect(record.formula?.servingSize?.citation.kind).toBe("text");
    expect(record.provenance).toHaveLength(2);
  });

  it("/3 collects a complete text with a verified incomplete-image Review; /2 stays blocked", async () => {
    const setup = await mergeSetup();
    const source = defined(setup.join.manifest.sources.find((entry) => entry.kind === "image"));
    if (source.kind !== "image") {
      throw new Error("image source expected");
    }
    const code = "VISION.LABEL_INGREDIENTS_INCOMPLETE";
    const review = reviewOf(setup, {
      id: "incomplete-image-review",
      code,
      operationId: source.task.input.operationId,
      inputFingerprint: visionFingerprint(source.task),
      stage: "codex.vision",
    });
    setup.records.set(review.reviewId, review);
    setup.join.states = setup.join.states.map((state) =>
      state.id === source.id
        ? { id: state.id, status: "review", reviewId: review.reviewId }
        : state,
    );
    const failure = { id: source.id, code, verifiedExecuted: true };
    const v2 = { ...setup.join.manifest, evidencePolicy: "label-image-first/2" as const };
    expect(mergeLabelProduct(v2, { entries: [setup.text], failures: [failure] }).status).toBe(
      "review",
    );
    setup.join.manifest.evidencePolicy = "label-image-first/3";
    const record = await collectBoth(setup);
    expect(record.formula?.servingSize?.citation.kind).toBe("text");
    expect(record.warnings).toContainEqual({ id: source.id, code });
    expect(setup.collected.size).toBe(1);
  });

  it("/3 keeps complete images first, and conflicting complete images still block", async () => {
    const setup = await mergeSetup([labelCandidate()], b12Text());
    setup.join.manifest.evidencePolicy = "label-image-first/3";
    const result = merge(setup);
    expect(result.status).toBe("ready");
    expect(result.formula?.servingSize?.citation.kind).toBe("image");
    const other = labelCandidate();
    defined(defined(rowsOf(other)[0]).amount).text = "999";
    const conflicting = await mergeSetup([labelCandidate(), other]);
    conflicting.join.manifest.evidencePolicy = "label-image-first/3";
    expect(merge(conflicting).status).toBe("review");
  });

  it("/5 treats an executed text citation failure as a warning only beside a complete image", async () => {
    const setup = await mergeSetup();
    setup.join.manifest.evidencePolicy = "label-image-first/5";
    const failure = { id: setup.text.id, code: "TEXT.CITATION_INVALID", verifiedExecuted: true };
    expect(merge(setup, images(setup), [failure])).toMatchObject({
      status: "ready",
      warnings: expect.arrayContaining([{ id: setup.text.id, code: "TEXT.CITATION_INVALID" }]),
    });
    expect(merge(setup, images(setup), [{ ...failure, verifiedExecuted: false }]).status).toBe(
      "review",
    );
    (defined(images(setup)[0]).candidate as LabelImageCandidate).formulaComplete = false;
    expect(merge(setup, images(setup), [failure]).status).toBe("review");
  });

  it("/5 still blocks foreign identity and unresolved text evidence", async () => {
    const setup = await mergeSetup();
    setup.join.manifest.evidencePolicy = "label-image-first/5";
    expect(
      merge(setup, images(setup), [{ id: setup.text.id, code: "LABEL_PRODUCT.TEXT_UNVERIFIED" }])
        .status,
    ).toBe("review");
    setup.text.record.input.observationId = "foreign";
    expect(() => merge(setup, [...images(setup), setup.text])).toThrow();
  });

  it("/5 collection keeps an executed citation Review as a warning, and cold readback agrees", async () => {
    const setup = await mergeSetup();
    setup.join.manifest.evidencePolicy = "label-image-first/5";
    const review = textReview(setup, "TEXT.CITATION_INVALID");
    const record = await collectBoth(setup);
    expect(setup.records.get(review.reviewId)).toEqual(review);
    expect(record.warnings).toContainEqual({ id: setup.text.id, code: "TEXT.CITATION_INVALID" });
  });
});
