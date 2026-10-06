import { expect, it } from "vitest";
import {
  LabelCollectedProductSchema,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { assemblySetup } from "../testing/assembly-fixture.js";
import { factsPanel, ingredientsPanel } from "../testing/split-label-fixture.js";
import { defined } from "../testing/defined.js";
import { mergeLabelProduct } from "./label-merge.js";

/** A printed panel heading, quoted the way the image model excludes it. */
function withHeading(candidate: LabelImageCandidate, heading: string): LabelImageCandidate {
  return {
    ...candidate,
    exclusions: [
      ...candidate.exclusions,
      { quote: { text: heading, evidence: heading }, reason: "heading" },
    ],
  };
}

// Owner 2026-10-06: a formula or an ingredient list alone is a product; both missing stays in Review.
it.each([
  {
    part: "formula",
    candidate: withHeading(factsPanel(), "Nutrition Facts"),
    labelType: "nutrition_facts",
  },
  { part: "ingredients", candidate: ingredientsPanel(), labelType: "none" },
] as const)("collects a $part-only label under /7 as collected-product/5", async (given) => {
  const test = assemblySetup([given.candidate]);
  test.join.manifest.evidencePolicy = "label-image-first/7";
  const signal = AbortSignal.timeout(5_000);
  const result = await test.assembly.run(test.join, signal);
  expect(result.status).toBe("ready");
  const input = { join: test.join, evidenceKey: result.evidenceKey };
  expect(await test.collector.run(input, signal)).toMatchObject({ status: "collected" });
  const collected = LabelCollectedProductSchema.parse(defined([...test.collected.values()][0]));
  expect(collected).toMatchObject({
    schemaVersion: 5,
    codec: "collected-product/5",
    labelType: given.labelType,
    formulaFound: given.part === "formula",
    ingredientsFound: given.part === "ingredients",
    pageEvidence: [],
  });
  expect(collected.formula === null).toBe(given.part === "ingredients");
  const missing =
    given.part === "formula" ? "VALIDATION.INGREDIENTS_MISSING" : "VALIDATION.FORMULA_MISSING";
  expect(collected.warnings).toContainEqual({ id: "label-product", code: missing });
});

it.each([
  ["formula", factsPanel()],
  ["ingredients", ingredientsPanel()],
] as const)("keeps a %s-only label in Review under /6", (_part, candidate) => {
  const test = assemblySetup([candidate]);
  test.join.manifest.evidencePolicy = "label-image-first/6";
  const result = mergeLabelProduct(test.join.manifest, { entries: [...test.entries.values()] });
  expect(result.status).toBe("review");
  expect(result.parts).toBeUndefined();
});

it("keeps a label with neither part in Review under /7", () => {
  const empty: LabelImageCandidate = {
    ...ingredientsPanel(),
    otherIngredients: null,
    ingredientsComplete: false,
  };
  const test = assemblySetup([empty]);
  test.join.manifest.evidencePolicy = "label-image-first/7";
  const result = mergeLabelProduct(test.join.manifest, { entries: [...test.entries.values()] });
  expect(result.status).toBe("review");
});
