import { expect, it, vi } from "vitest";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { ReviewRecordSchema, ProductEvidenceManifestSchema, textFingerprint } from "@crawl-automation/v3-contracts";
import { digest } from "@crawl-automation/v3-vision";
import { mixedFixture } from "./mixed.fixture.js";
import { mergeProductEvidence } from "./mixed-merge.js";
import { ProductEvidenceAssembly, mixedAssemblyKey } from "./mixed-assembly.js";
const signal = () => new AbortController().signal;
async function matchingFormula() {
  const f = await mixedFixture(), entry = f.entries.find(e => e.kind === "text")!;
  if (entry.kind !== "text") throw Error();
  entry.fullText = "1 capsule Blend 10 mg Water";
  entry.record.input.range.end = entry.fullText.length;
  entry.record.input.inputFingerprint = textFingerprint(entry.record.input, digest);
  f.join.manifest.sources.find(s => s.kind === "text")!.task = entry.record.input;
  const quote = (text: string) => ({ text, start: entry.fullText.indexOf(text), end: entry.fullText.indexOf(text) + text.length });
  entry.candidate = { schemaVersion: 2, formula: { servingSize: quote("1 capsule"), nutrients: [{ name: quote("Blend"), amount: quote("10 mg"), dailyValue: null }] },
    ingredients: { items: [{ ...quote("Water"), role: "other", parentNutrientIndex: null }] } };
  return f;
}
it("matching single-column formula preserves heading and accumulates exact citations", async () => {
  const f = await matchingFormula(), out = mergeProductEvidence(f.join.manifest, f.entries);
  expect(out.status).toBe("ready"); expect(out.formula!.columns[0]!.heading).toBe("Per serving");
  expect(out.formula!.columns[0]!.nutrients[0]!.amount!.citations.map(c => c.kind)).toEqual(["image", "text"]);
});
it.each(["dose", "unit", "serving", "columns"])("formula %s disagreement is never silently reconciled", async kind => {
  const f = await matchingFormula(), entry = f.entries.find(e => e.kind === "image")!;
  if (entry.kind !== "image") throw Error();
  const formula = entry.candidate.formula!;
  if (kind === "dose") formula.columns[0]!.nutrients[0]!.amount!.text = "20 mg";
  if (kind === "unit") formula.columns[0]!.nutrients[0]!.amount!.text = "10 Mg";
  if (kind === "serving") formula.servingSize!.text = "2 capsules";
  if (kind === "columns") formula.columns.push(structuredClone(formula.columns[0]!));
  expect(mergeProductEvidence(f.join.manifest, f.entries).codes).toContain("VALIDATION.FORMULA_CONFLICT");
});
it("image formula and text Ingredients complement without fabricated visual offsets", async () => {
  const f = await mixedFixture(), result = mergeProductEvidence(f.join.manifest, f.entries);
  expect(result.status).toBe("ready"); expect(result.ingredients).toHaveLength(2);
  expect(result.formula!.columns[0]!.nutrients[0]!.name.citations[0]).toMatchObject({ kind: "image", sourceId: "image" });
  expect(result.ingredients.find(i => i.role === "other")!.name.citations[0]).toEqual({ kind: "text", sourceId: "text", text: "Water", start: 19, end: 24 });
  expect(mergeProductEvidence(f.join.manifest, [...f.entries].reverse())).toEqual(result);
});
it("optional failed source cannot block complete evidence; required failure does", async () => {
  const f = await mixedFixture(); f.join.manifest.sources.find(s => s.id === "text")!.required = false;
  const result = mergeProductEvidence(f.join.manifest, f.entries.filter(e => e.kind === "image"), [{ id: "text", code: "TEXT.CODEX_TURN_FAILED" }]);
  expect(result.status).toBe("ready"); expect(result.warnings).toEqual([{ id: "text", code: "TEXT.CODEX_TURN_FAILED" }]);
  f.join.manifest.sources.find(s => s.id === "text")!.required = true;
  expect(mergeProductEvidence(f.join.manifest, f.entries.filter(e => e.kind === "image"), [{ id: "text", code: "TEXT.CODEX_TURN_FAILED" }]).codes).toContain("TEXT.CODEX_TURN_FAILED");
});
it("valid optional disagreement is still a conflict, not ignored or unioned", async () => {
  const f = await mixedFixture(), image = f.entries.find(e => e.kind === "image")!;
  if (image.kind !== "image") throw Error();
  image.candidate.ingredients.push({ name: "Cellulose", evidence: "Cellulose", role: "other", parentBlend: null });
  f.join.manifest.sources.find(s => s.id === "text")!.required = false;
  expect(mergeProductEvidence(f.join.manifest, f.entries).codes).toContain("VALIDATION.INGREDIENTS_CONFLICT");
});
it("agreeing sections deduplicate while keeping image and text citations", async () => {
  const f = await mixedFixture(), image = f.entries.find(e => e.kind === "image")!; if (image.kind !== "image") throw Error();
  image.candidate.ingredients.push({ name: "Water", evidence: "label Water", role: "other", parentBlend: null });
  const out = mergeProductEvidence(f.join.manifest, f.entries);
  expect(out.status).toBe("ready"); expect(out.ingredients.filter(i => i.role === "other")).toHaveLength(1);
  expect(out.ingredients.find(i => i.role === "other")!.name.citations.map(c => c.kind)).toEqual(["image", "text"]);
});
it("missing evidence is not an empty result and neither core field can be omitted", async () => {
  const f = await mixedFixture();
  expect(mergeProductEvidence(f.join.manifest, []).codes).toEqual(["MIXED.BARRIER_INCOMPLETE", "VALIDATION.FORMULA_MISSING", "VALIDATION.INGREDIENTS_MISSING"]);
  expect(mergeProductEvidence(f.join.manifest, f.entries.filter(e => e.kind === "text"), [{ id: "image", code: "VISION.FAILURE" }]).codes).toContain("VALIDATION.FORMULA_MISSING");
});
it("duplicate operations, variants, wrong configs and invalid text offsets cannot mix", async () => {
  const f = await mixedFixture(), text = f.entries.find(e => e.kind === "text")!;
  const other = structuredClone(f.join.manifest); other.observation.variantId = "other";
  expect(ProductEvidenceManifestSchema.safeParse(other).success).toBe(false);
  expect(() => mergeProductEvidence(f.join.manifest, [...f.entries, text])).toThrow("MIXED.IDENTITY_CONFLICT");
  if (text.kind !== "text") throw Error(); text.record.input.configFingerprint = "c".repeat(64);
  expect(() => mergeProductEvidence(f.join.manifest, f.entries)).toThrow("MIXED.IDENTITY_CONFLICT");
});
it("full text scope and exact citations are required, not an invented complete formula", async () => {
  const f = await mixedFixture(), text = f.entries.find(e => e.kind === "text")!; if (text.kind !== "text") throw Error();
  text.fullText += " unknown trailing content";
  expect(() => mergeProductEvidence(f.join.manifest, f.entries)).toThrow("MIXED.TEXT_SCOPE_UNVERIFIED");
  text.fullText = f.text; text.candidate.ingredients!.items[0]!.start++;
  expect(() => mergeProductEvidence(f.join.manifest, f.entries)).toThrow("TEXT.CITATION_INVALID");
});
it("registered source integrity is rechecked, fresh assembly cache has zero new model/PUT", async () => {
  const f = await mixedFixture(), result = await f.service.run(f.join, signal()); expect(result.status).toBe("ready");
  const writes = f.remote.writes;
  const next = new ProductEvidenceAssembly({ ...f.deps, local: new MemoryObjects() });
  expect(await next.run({ manifest: { ...f.join.manifest, sources: [...f.join.manifest.sources].reverse() }, states: [...f.join.states].reverse() }, signal())).toEqual(result);
  expect(f.remote.writes).toBe(writes); expect(f.calls()).toEqual([1, 1]);
  expect((await next.inspectReady(f.join, result.evidenceKey, signal())).output.result.provenance).toHaveLength(2);
  f.remote.data.set(f.source.objectKey, Buffer.from("broken"));
  expect(await next.run(f.join, signal())).toMatchObject({ status: "review", codes: ["MIXED.EVIDENCE_UNVERIFIED", "MIXED.HANDOFF_UNVERIFIED"] });
});
it("missing terminal states and forged upstream Review are not silently optional", async () => {
  const f = await mixedFixture();
  expect(await f.service.run({ ...f.join, states: [] }, signal())).toMatchObject({ codes: ["MIXED.BARRIER_INCOMPLETE"] });
  f.join.manifest.sources[0]!.required = false; f.join.states[0] = { id: "text", status: "review", reviewId: "missing" };
  expect(await f.service.run(f.join, signal())).toMatchObject({ codes: ["MIXED.REVIEW_UNVERIFIED"] });
});
it("verified optional Review remains visible in ready evidence", async () => {
  const f = await mixedFixture(), r = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: "upstream", occurredAt: new Date().toISOString(),
    observation: f.owner, failure: { schemaVersion: 1, requestId: f.task.requestId, observationId: f.task.observationId, operationId: f.task.operationId,
      inputFingerprint: f.task.inputFingerprint, stage: "codex.text", category: "PROCESSING", code: "TEXT.CODEX_TURN_FAILED", executionFact: "unknown", evidenceKey: "upstream/evidence.json", blockedBy: null, automaticRetry: false },
    rawError: { name: "Fixture", message: "Fixture", stack: null, details: {} }, candidate: null, inspection: { kind: "none" } });
  f.reviews.records.set(r.reviewId, r); f.join.manifest.sources[0]!.required = false;
  f.join.states[0] = { id: "text", status: "review", reviewId: r.reviewId };
  const result = await f.service.run(f.join, signal()); expect(result.status).toBe("ready");
  expect((await f.service.inspectReady(f.join, result.evidenceKey, signal())).output.result.warnings).toEqual([{ id: "text", code: "TEXT.CODEX_TURN_FAILED" }]);
});
it("unknown assembly publication is never retried from a new cache", async () => {
  const f = await mixedFixture(), create = f.remote.create.bind(f.remote); let puts = 0;
  vi.spyOn(f.remote, "create").mockImplementation(async (key, bytes) => { if (key === mixedAssemblyKey(f.join)) { puts++; throw Error("synthetic failure"); } return create(key, bytes); });
  expect(await f.service.run(f.join, signal())).toMatchObject({ codes: ["MIXED.HANDOFF_UNVERIFIED"] });
  expect(await new ProductEvidenceAssembly({ ...f.deps, local: new MemoryObjects() }).run(f.join, signal())).toMatchObject({ codes: ["MIXED.HANDOFF_PENDING"] });
  expect(puts).toBe(1); expect(f.calls()).toEqual([1, 1]);
});
it("failed Review persistence is surfaced, not reported as queued", async () => {
  const f = await mixedFixture(); f.deps.reviews.append = async () => { throw Error("private details"); };
  await expect(f.service.run({ ...f.join, states: [] }, signal())).rejects.toThrow("MIXED.REVIEW_UNVERIFIED");
});
