import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  ArtifactRefSchema,
  LabelCollectedProductSchema,
  TextCandidateV3Schema,
  TextInputSchema,
  textFingerprint,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/platform";
import { assemblySetup, textEntry } from "../testing/assembly-fixture.js";
import { hashString } from "../results/result-record.js";
import { decodeLabelText } from "../text/protocol/label-decoder.js";
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

it("collects the retained Dherbs text Ingredients list when images offered no label source", async () => {
  const root = new URL("../../../../tools/diag-corpus/round9/dherbs-capsules/", import.meta.url);
  const basename = "chl-75407496707e642cdab2e0693fb1ed54e9e520746432e26c05f83ba9750ebb1e.json";
  const reviews: Array<{
    failure: { evidenceKey: string };
    candidate: { value: { rawResponse: string } };
  }> = JSON.parse(readFileSync(new URL("reviews.json", root), "utf8"));
  const review = reviews.find((item) => item.failure?.evidenceKey?.endsWith(basename));
  if (!review) {
    throw new Error("Missing retained Detox answer");
  }
  const intent = JSON.parse(readFileSync(new URL(basename, root), "utf8"));
  const core = JSON.parse(readFileSync(new URL(`core/${basename}`, root), "utf8"));
  const decoded = decodeLabelText({
    scope: { range: intent.input.range },
    text: core.text,
    response: review.candidate.value.rawResponse,
    policyVersion: intent.input.policyVersion,
  });
  expect(decoded.status).toBe("partial");

  const entry = textEntry(ingredientsPanel());
  entry.candidate = TextCandidateV3Schema.parse({ ...decoded.candidate, schemaVersion: 3 });
  entry.fullText = core.text;
  const unsigned = { ...entry.record.input, range: { start: 0, end: core.text.length } };
  entry.record.input = TextInputSchema.parse({
    ...unsigned,
    inputFingerprint: textFingerprint(unsigned, hashString),
  });
  if (entry.record.input.source.kind !== "prepared") {
    throw new Error("Fixture text source must be prepared");
  }
  const html = Buffer.from("<html><body>Ingredients</body></html>");
  const document = entry.record.input.source.document;
  entry.evidence = {
    document,
    page: ArtifactRefSchema.parse({
      ...document,
      artifactId: "synthetic-page",
      kind: "source-html",
      mediaType: "text/html",
      objectKey: "synthetic/page.html",
      sha256: sha256(html),
      byteSize: html.length,
    }),
  };
  const test = assemblySetup();
  test.join.manifest.sources = [
    { id: entry.id, kind: "text", required: true, task: entry.record.input },
  ];
  test.join.states = [{ id: entry.id, status: "registered" }];
  test.join.manifest.evidencePolicy = "label-image-first/7";
  test.deps.readSource.mockResolvedValue(entry);
  const signal = AbortSignal.timeout(5_000);
  const assembled = await test.assembly.run(test.join, signal);
  expect(assembled.status).toBe("ready");
  expect(
    await test.collector.run({ join: test.join, evidenceKey: assembled.evidenceKey }, signal),
  ).toMatchObject({ status: "collected" });
  const collected = LabelCollectedProductSchema.parse(defined([...test.collected.values()][0]));
  expect(collected).toMatchObject({
    schemaVersion: 5,
    labelType: "none",
    formulaFound: false,
    ingredientsFound: true,
  });
  expect(collected.formula).toBeNull();
  expect(collected.ingredients).toHaveLength(10);
  expect(collected.ingredients.every((item) => item.amount === null && item.role === "other")).toBe(
    true,
  );
  expect(collected.warnings).toContainEqual({
    id: entry.id,
    code: "LABEL.FORMULA_IS_INGREDIENT_LIST",
  });
  expect(collected.warnings).toContainEqual({
    id: "label-product",
    code: "VALIDATION.FORMULA_MISSING",
  });
});
