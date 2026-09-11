import { expect, it } from "vitest";
import { type VisionCandidate, type VisionRecord } from "@crawl-automation/v3-contracts";
import { candidate, selection, observation } from "../../v3-vision/src/testing.fixture.js";
import { mergeProductImages } from "./merge.js";
const entry = (id: string, c: VisionCandidate = structuredClone(candidate)) => {
  const s = selection(); s.image.artifactId = id;
  const ref = (part: string) => ({ ...s.image, artifactId: `${id}-${part}`, kind: "result-json" as const, mediaType: "application/json" as const,
    objectKey: `${id}/${part}.json`, producer: { operationId: `vision-${id}`, module: "codex.vision", implementationVersion: "vision/1" } });
  const record: VisionRecord = { schemaVersion: 1, codec: "vision-result/1", storageId: "test/1", input: { operationId: `vision-${id}`, selection: s },
    configFingerprint: "a".repeat(64), status: "candidate", result: ref("result"), completion: ref("completion") };
  return { record, candidate: c };
};
const manifest = { operationId: "product-1", observation, imageIds: ["a", "b"], configFingerprint: "a".repeat(64) };
it("joins Formula and Ingredients from separate images, retains both source refs", () => {
  const a = entry("a", { ...candidate, ingredients: [], ingredientsComplete: false });
  const b = entry("b", { ...candidate, formula: null, formulaComplete: false });
  const result = mergeProductImages(manifest, [b, a]);
  expect(result.status).toBe("ready"); expect(result.ingredients).toHaveLength(1); expect(result.provenance).toHaveLength(2);
  expect(mergeProductImages(manifest, [a, b])).toEqual(result);
});
it("deduplicates agreeing image copies without duplicating ingredients", () => {
  expect(mergeProductImages(manifest, [entry("a"), entry("b")]).ingredients).toHaveLength(1);
});
it("conflicting amounts do not use last-write-wins", () => {
  const a = entry("a"), b = entry("b"); b.candidate.formula!.columns[0]!.nutrients[0]!.amount!.text = "20 mg";
  const r = mergeProductImages(manifest, [a, b]);
  expect(r.codes).toContain("VALIDATION.FORMULA_CONFLICT"); expect(mergeProductImages(manifest, [b, a])).toEqual(r);
});
it("different ingredient lists for the same section are conflicts, not guessed unions", () => {
  const b = entry("b"); b.candidate.ingredients[0]!.name = "Different herb";
  expect(mergeProductImages(manifest, [entry("a"), b]).codes).toContain("VALIDATION.INGREDIENTS_CONFLICT");
});
it("does not case-fold or convert dose units during conflict checks", () => {
  const a = entry("a"), b = entry("b");
  a.candidate.formula!.columns[0]!.nutrients[0]!.amount!.text = "1 mIU";
  b.candidate.formula!.columns[0]!.nutrients[0]!.amount!.text = "1 MIU";
  expect(mergeProductImages(manifest, [a, b]).codes).toContain("VALIDATION.FORMULA_CONFLICT");
});
it("different ingredient sections combine while missing parent is rejected", () => {
  const b = entry("b", { ...candidate, formula: null, formulaComplete: false,
    ingredients: [{ name: "Water", evidence: "Water", role: "other", parentBlend: null }] });
  expect(mergeProductImages(manifest, [entry("a"), b]).ingredients).toHaveLength(2);
  b.candidate.ingredients = [{ name: "Root", evidence: "Root", role: "blend_component", parentBlend: "Wrong blend" }];
  expect(mergeProductImages(manifest, [entry("a"), b]).codes).toContain("VALIDATION.INGREDIENT_PARENT_CONFLICT");
});
it.each(["owner", "variant", "config", "duplicate"])("rejects %s conflicts", kind => {
  const a = entry("a");
  if (kind === "owner") a.record.input.selection.observation.brandId = "another-brand";
  if (kind === "variant") a.record.input.selection.observation.variantId = "other-variant";
  if (kind === "config") a.record.configFingerprint = "b".repeat(64);
  expect(() => mergeProductImages(manifest, kind === "duplicate" ? [a, a] : [a])).toThrow();
});
it("records both core missing codes, but does not require company/price/rating", () => {
  expect(mergeProductImages(manifest, []).codes).toEqual(["VALIDATION.FORMULA_MISSING", "VALIDATION.INGREDIENTS_MISSING"]);
  expect(mergeProductImages(manifest, [entry("a")]).status).toBe("ready");
});
