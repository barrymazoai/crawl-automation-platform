import { expect, it } from "vitest";
import {
  LabelCollectedProductSchema,
  LabelReviewedImageRecordSchema,
} from "@crawl-automation/v3-contracts";
import { assemblySetup } from "../testing/assembly-fixture.js";
import {
  croppedPanel,
  factsPanel,
  ingredientsPanel,
  splitReview,
} from "../testing/split-label-fixture.js";
import { defined } from "../testing/defined.js";
import { textEntry } from "../testing/label-sources.js";
import { mergeLabelProduct } from "./label-merge.js";

it.each([false, true])(
  "collects and cold-reads complementary panels (reviewed facts: %s)",
  async (reviewed) => {
    const candidate = reviewed ? croppedPanel() : factsPanel();
    const test = assemblySetup([candidate, ingredientsPanel()]);
    test.join.manifest.evidencePolicy = "label-image-first/6";
    if (reviewed) {
      const source = defined(test.join.manifest.sources[0]);
      const review = splitReview(source, candidate);
      test.records.set(review.reviewId, review);
      test.join.states[0] = { id: source.id, status: "review", reviewId: review.reviewId };
      Object.assign(test.deps, {
        readReviewedImage: async ({ task }: { task: unknown }) => ({
          candidate,
          record: LabelReviewedImageRecordSchema.parse({
            codec: "vision-reviewed/1",
            ...(task as object),
            review,
            result: defined(test.entries.get(source.id)).record.result,
          }),
        }),
      });
    }
    const signal = AbortSignal.timeout(5_000);
    const result = await test.assembly.run(test.join, signal);
    expect(result.status).toBe("ready");
    const input = { join: test.join, evidenceKey: result.evidenceKey };
    expect(await test.collector.run(input, signal)).toMatchObject({ status: "collected" });
    expect(await test.cold().collector.run(input, signal)).toMatchObject({ status: "collected" });
    const collected = defined([...test.collected.values()][0]);
    expect(collected.formula.servingSize?.sourceId).toBe("source-0");
    expect(collected.otherIngredients?.heading.sourceId).toBe("source-1");
    expect(collected.provenance[0]?.candidate).toEqual(candidate);
    expect(LabelCollectedProductSchema.safeParse(collected).success).toBe(true);
    if (reviewed) {
      expect(collected.provenance[0]).toMatchObject({
        record: {
          codec: "vision-reviewed/1",
          review: { failure: { code: "VISION.LABEL_INGREDIENTS_INCOMPLETE" } },
        },
      });
    }
  },
);

it.each([
  "incomplete",
  "ambiguous",
  "unreadable amount",
  "unknown section",
  "ingredient conflict",
  "formula conflict",
])("keeps %s in Review", (mode) => {
  const facts = croppedPanel();
  const ingredients = ingredientsPanel();
  damagePanels(mode, { facts, ingredients });
  const test = assemblySetup([facts, ingredients]);
  test.join.manifest.evidencePolicy = "label-image-first/6";
  const result = mergeLabelProduct(test.join.manifest, { entries: [...test.entries.values()] });
  expect(result.status).toBe("review");
  if (mode.endsWith("conflict")) {
    expect(result.codes).toContain(
      mode === "formula conflict"
        ? "LABEL_PRODUCT.FORMULA_CONFLICT"
        : "LABEL_PRODUCT.INGREDIENTS_CONFLICT",
    );
  }
});

it("does not change historical /5 partial-image decisions", () => {
  const test = assemblySetup([croppedPanel(), ingredientsPanel()]);
  test.join.manifest.evidencePolicy = "label-image-first/5";
  expect(
    mergeLabelProduct(test.join.manifest, { entries: [...test.entries.values()] }).status,
  ).toBe("review");
});

it("combines registered text facts and image ingredients through the same merger", () => {
  const facts = textEntry(factsPanel());
  const test = assemblySetup([ingredientsPanel()]);
  test.join.manifest.evidencePolicy = "label-image-first/6";
  test.join.manifest.sources.push({
    id: facts.id,
    kind: "text",
    required: true,
    task: facts.record.input,
  });
  const result = mergeLabelProduct(test.join.manifest, {
    entries: [facts, ...test.entries.values()],
  });
  expect(result.status).toBe("ready");
  expect(result.formula?.servingSize?.citation.kind).toBe("text");
  expect(result.otherIngredients?.heading.citation.kind).toBe("image");
});

function damagePanels(
  mode: string,
  panels: {
    facts: ReturnType<typeof factsPanel>;
    ingredients: ReturnType<typeof ingredientsPanel>;
  },
) {
  const { facts, ingredients } = panels;
  if (mode === "incomplete") {
    ingredients.ingredientsComplete = false;
  } else if (mode === "ambiguous") {
    facts.issues = [{ code: "AMBIGUOUS", detail: "Different packages" }];
  } else if (mode === "unreadable amount") {
    const row = firstRow(facts);
    row.amount = null;
    row.amountStatus = "unreadable";
  } else if (mode === "unknown section") {
    facts.formulaComplete = true;
    facts.ingredientsComplete = true;
  } else if (mode === "ingredient conflict") {
    defined(ingredients.otherIngredients?.items[0]).text = "Soy";
  } else {
    ingredients.formula = structuredClone(facts.formula);
    defined(firstRow(ingredients).amount).text = "999 mg";
  }
}

function firstRow(candidate: ReturnType<typeof factsPanel>) {
  return defined(candidate.formula?.columns[0]?.rows[0]);
}
