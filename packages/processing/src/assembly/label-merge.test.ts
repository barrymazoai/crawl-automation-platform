import { describe, expect, it } from "vitest";
import {
  LabelCollectedProductSchema,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { labelCandidate } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import {
  b12Text,
  collectBoth,
  images,
  merge,
  mergeSetup,
  rowsOf,
  signal,
  textReview,
} from "../testing/merge-fixture.js";
import { mergeLabelProduct } from "./label-merge.js";

// Cases carried over from the former image-first label policy tests (/1 and /2).
describe("label merge policies", () => {
  it("the image wins B12 grouping, text only warns, both originals are kept, cold readback agrees", async () => {
    const setup = await mergeSetup([labelCandidate()], b12Text());
    const old = structuredClone(setup.join.manifest);
    delete old.evidencePolicy;
    expect(mergeLabelProduct(old, { entries: setup.entries }).codes).toContain(
      "LABEL_PRODUCT.FORMULA_CONFLICT",
    );
    const record = await collectBoth(setup);
    expect(record.evidencePolicy).toBe("label-image-first/1");
    expect(defined(record.formula.columns[0]).rows[17]).toMatchObject({
      kind: "blend_component",
      parentRowIndex: 13,
      name: { citation: { kind: "image" } },
    });
    expect(record.warnings).toContainEqual({
      id: "a-text",
      code: "LABEL_PRODUCT.SECONDARY_TEXT_FORMULA_CONFLICT",
    });
    expect(record.provenance).toHaveLength(2);
    expect(LabelCollectedProductSchema.safeParse({ ...record, warnings: [] }).success).toBe(false);
    const textProvenance = defined(record.provenance.find((entry) => entry.kind === "text"));
    expect(textProvenance.candidate.formula?.columns[0]?.rows[17]?.kind).toBe("nutrient");
    expect(setup.registry.append).toHaveBeenCalledTimes(1);
  });

  it("the order of entries cannot change the chosen image", async () => {
    const setup = await mergeSetup([labelCandidate()], b12Text());
    const reversed = {
      ...setup.join.manifest,
      sources: [...setup.join.manifest.sources].reverse(),
    };
    expect(merge(setup)).toEqual(
      mergeLabelProduct(reversed, { entries: [...setup.entries].reverse() }),
    );
  });

  it("/2 lets a complete image excuse a verified, executed text quality failure; /1 does not", async () => {
    const setup = await mergeSetup();
    const failure = { id: "a-text", code: "TEXT.LABEL_GROUP_EMPTY", verifiedExecuted: true };
    expect(merge(setup, images(setup), [failure]).status).toBe("review");
    setup.join.manifest.evidencePolicy = "label-image-first/2";
    const result = merge(setup, images(setup), [failure]);
    expect(result.status).toBe("ready");
    expect(result.warnings).toContainEqual({ id: "a-text", code: "TEXT.LABEL_GROUP_EMPTY" });
    expect(result.formula?.servingSize?.citation.kind).toBe("image");
  });

  it("/2 collection keeps the reviewed text source and survives cold readback", async () => {
    const setup = await mergeSetup();
    setup.join.manifest.evidencePolicy = "label-image-first/2";
    const review = textReview(setup, "TEXT.LABEL_GROUP_EMPTY");
    const record = await collectBoth(setup);
    expect(record.evidencePolicy).toBe("label-image-first/2");
    expect(record.warnings).toContainEqual({ id: "a-text", code: "TEXT.LABEL_GROUP_EMPTY" });
    expect(setup.records.get(review.reviewId)).toEqual(review);
  });

  it.each(["unconfirmed", "no complete image", "identity", "missing receipt"])(
    "/2 still blocks %s",
    async (mode) => {
      const setup = await mergeSetup();
      setup.join.manifest.evidencePolicy = "label-image-first/2";
      const codes: Record<string, string> = {
        identity: "TEXT.SOURCE_CONFLICT",
        "missing receipt": "TEXT_RECEIPT.TEXT_UNCONFIRMED",
      };
      const failure = {
        id: "a-text",
        code: codes[mode] ?? "TEXT.LABEL_GROUP_EMPTY",
        verifiedExecuted: mode !== "unconfirmed",
      };
      if (mode === "no complete image") {
        (defined(setup.entries[0]).candidate as LabelImageCandidate).ingredientsComplete = false;
      }
      expect(merge(setup, images(setup), [failure]).status).toBe("review");
    },
  );

  it("/2 cold Review readback returns the one durable Review, never a second", async () => {
    const setup = await mergeSetup();
    setup.join.manifest.evidencePolicy = "label-image-first/2";
    setup.join.states = setup.join.states.map((state) => ({ id: state.id, status: "unresolved" }));
    setup.deps.readSource.mockRejectedValue(new Error("unavailable"));
    const first = await setup.assembly.run(setup.join, signal());
    const writes = setup.remote.writes;
    expect(first.status).toBe("review");
    expect(setup.records.size).toBe(1);
    expect(await setup.cold().assembly.run(setup.join, signal())).toEqual(first);
    expect([setup.records.size, setup.remote.writes]).toEqual([1, writes]);
  });

  it("renaming source IDs does not give text priority", async () => {
    const setup = await mergeSetup([labelCandidate()], b12Text());
    const [image, text] = setup.entries;
    defined(image).id = "a-image";
    defined(setup.join.manifest.sources[0]).id = "a-image";
    defined(text).id = "z-text";
    defined(setup.join.manifest.sources[1]).id = "z-text";
    const out = merge(setup);
    expect(out.status).toBe("ready");
    expect(out.formula?.servingSize?.sourceId).toBe("a-image");
  });

  it("a text ingredients difference only warns and is never merged into the image", async () => {
    const text = labelCandidate();
    defined(text.otherIngredients?.items[0]).text = "Different syrup";
    const setup = await mergeSetup([labelCandidate()], text);
    const out = merge(setup);
    expect(out.status).toBe("ready");
    expect(out.otherIngredients?.items[0]?.text).toBe("Malt Syrup");
    expect(out.warnings).toContainEqual({
      id: "a-text",
      code: "LABEL_PRODUCT.SECONDARY_TEXT_INGREDIENTS_CONFLICT",
    });
  });

  it.each(["amount", "ingredients", "group"])(
    "conflicting images still block (%s)",
    async (kind) => {
      const other = labelCandidate();
      const rows = rowsOf(other);
      if (kind === "amount") {
        defined(defined(rows[5]).amount).text = "201 mg";
      }
      if (kind === "ingredients") {
        defined(other.otherIngredients?.items[0]).text = "Different syrup";
      }
      if (kind === "group") {
        defined(rows[17]).kind = "nutrient";
        defined(rows[17]).parentRowIndex = null;
      }
      const setup = await mergeSetup([labelCandidate(), other]);
      expect(merge(setup).status).toBe("review");
    },
  );

  it("an incomplete required image gets no priority and never passes silently", async () => {
    const setup = await mergeSetup();
    (defined(images(setup)[0]).candidate as LabelImageCandidate).formulaComplete = false;
    const out = merge(setup);
    expect(out.status).toBe("review");
    expect(out.codes).toContain("LABEL.FORMULA_INCOMPLETE");
    expect(out.formula?.servingSize?.citation.kind).toBe("text");
  });

  it("without an image, the complete text is admitted as before", async () => {
    const setup = await mergeSetup();
    setup.join.manifest.sources = setup.join.manifest.sources.filter(
      (source) => source.kind === "text",
    );
    const out = merge(setup, [setup.text]);
    expect(out.status).toBe("ready");
    expect(out.formula?.servingSize?.citation.kind).toBe("text");
  });

  it.each(["identity", "citation", "barrier", "failure"])(
    "image priority never bypasses %s checks",
    async (kind) => {
      const setup = await mergeSetup();
      const image = defined(images(setup)[0]);
      if (kind === "identity") {
        setup.text.record.input.operationId = "foreign";
        expect(() => merge(setup, [image, setup.text])).toThrow();
      }
      if (kind === "citation") {
        defined(setup.text.candidate.formula?.servingSize).start++;
        expect(() => merge(setup, [image, setup.text])).toThrow("TEXT.CITATION_INVALID");
      }
      if (kind === "barrier") {
        expect(merge(setup, [image]).codes).toContain("LABEL_PRODUCT.BARRIER_INCOMPLETE");
      }
      if (kind === "failure") {
        expect(
          merge(setup, [image], [{ id: "a-text", code: "LABEL_PRODUCT.EVIDENCE_UNRESOLVED" }])
            .status,
        ).toBe("review");
      }
    },
  );

  it.each(["unknown", "identity", "missing receipt", "incomplete text"])(
    "/3 fallback still refuses %s",
    async (kind) => {
      const setup = await mergeSetup();
      setup.join.manifest.evidencePolicy = "label-image-first/3";
      const codes: Record<string, string> = {
        identity: "VISION.INPUT_CONFLICT",
        "missing receipt": "VISION.HANDOFF_PENDING",
      };
      const failure = {
        id: defined(setup.entries[0]).id,
        code: codes[kind] ?? "VISION.LABEL_INGREDIENTS_INCOMPLETE",
        verifiedExecuted: kind !== "unknown",
      };
      if (kind === "incomplete text") {
        setup.text.candidate.ingredientsComplete = false;
      }
      expect(merge(setup, [setup.text], [failure]).status).toBe("review");
    },
  );
});
