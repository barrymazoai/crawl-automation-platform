import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { ArtifactRefSchema, LabelCollectedProductSchema, LabelProductManifestSchema, PackagingFactsSchema } from "@crawl-automation/v3-contracts";
import { gncLabelFixture } from "../../v3-contracts/src/label.fixture.js";
import { labelProductFixture } from "./label-product.fixture.js";
import { labelCollectedHash } from "./label-product.js";
const signal = () => new AbortController().signal;
async function fixture(candidates = [gncLabelFixture()], values = ["3", "12"]) {
  const f = await labelProductFixture(candidates), image = f.inputs[0]!.task.input.selection.image;
  const ref = ArtifactRefSchema.parse({ ...image, kind: "result-json", mediaType: "application/json", objectKey: "packaging/document.json",
    producer: { operationId: "prepared", module: "page.prepare", implementationVersion: "1" } });
  const claims = values.map((value, index) => { const text = `Servings Per Container: ${value}`; return { document: ref,
    field: "servingsPerContainer", value, quote: { text, start: index * 40, end: index * 40 + text.length } }; });
  const unique = [...new Set(values)];
  const packaging = PackagingFactsSchema.parse({ codec: "packaging-facts/1", observation: f.join.manifest.observation,
    productComposition: "unknown", containerCount: null, servingSize: { status: "unknown", value: null, claims: [] },
    servingsPerContainer: { status: unique.length > 1 ? "conflict" : unique.length ? "observed" : "unknown", value: unique.length === 1 ? unique[0] : null, claims },
    unresolvedPackMentions: [], warnings: unique.length > 1 ? ["PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT"] : [], blockingIssues: [] });
  f.join.manifest.admission = { policy: "label-packaging/1", documents: [ref] }; f.deps.readPackaging.mockResolvedValue(packaging);
  return { ...f, packaging };
}
it("packaging conflict permits /4 collection, null count, immutable raw claims and cold idempotent readback", async () => {
  const f = await fixture(), out = await f.assembly.run(f.join, signal()); expect(out.status).toBe("ready");
  const input = { join: f.join, evidenceKey: out.evidenceKey }, result = await f.collector.run(input, signal());
  expect(result.status).toBe("collected"); const record = [...f.collected.values()][0]!;
  expect(record).toMatchObject({ schemaVersion: 4, codec: "collected-product/4", formula: { servingsPerContainer: null } });
  expect(record.provenance[0]!.candidate.formula!.servingsPerContainer!.text).toBe("3");
  if (record.schemaVersion !== 4) throw Error();
  expect(record.packaging.servingsPerContainer.claims.map(c => c.value)).toEqual(["3", "12"]);
  expect(record.warnings).toEqual([{ id: f.join.manifest.operationId, code: "PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT" }]);
  const hash = labelCollectedHash(record), writes = f.remote.writes;
  expect(await f.cold().collector.run(input, signal())).toEqual(result); expect(f.registry.append).toHaveBeenCalledTimes(1);
  expect(f.remote.writes).toBe(writes); expect(labelCollectedHash(record)).toBe(hash);
  // Optional Mini-only database regression input; explicitly synthetic, never a live quality claim.
  const exportPath = process.env.V3_PACKAGING_TEST_RECORD;
  if (exportPath) {
    expect(exportPath).toMatch(/^\/Users\/barry\/apps\/crawlv3-packaging-tests\.[A-Za-z0-9]+\/synthetic-collected\.json$/);
    await writeFile(exportPath, JSON.stringify({ synthetic: true, record }), { mode: 0o600, flag: "wx" });
  }
});
it("count differences across accepted sources do not become formula conflicts", async () => {
  const second = gncLabelFixture(); second.formula!.servingsPerContainer!.text = "12";
  const f = await fixture([gncLabelFixture(), second], []), out = await f.assembly.run(f.join, signal());
  expect(out.status).toBe("ready"); expect((await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal())).status).toBe("collected");
});
it.each(["amount", "serving-size", "group", "ingredients"])("still blocks core %s conflicts even for optional sources", async kind => {
  const second = gncLabelFixture();
  if (kind === "amount") second.formula!.columns[0]!.rows[5]!.amount!.text = "201 mg";
  if (kind === "serving-size") second.formula!.servingSize!.text = "3";
  if (kind === "group") { const row = second.formula!.columns[0]!.rows[17]!; row.kind = "nutrient"; row.parentRowIndex = null; }
  if (kind === "ingredients") second.otherIngredients!.items[0]!.text = "Different syrup";
  const f = await fixture([gncLabelFixture(), second]); f.join.manifest.sources[1]!.required = false;
  expect((await f.assembly.run(f.join, signal())).status).toBe("review"); expect(f.collected.size).toBe(0);
});
it("does not convert arbitrary candidate metadata uncertainty into packaging success", async () => {
  const f = await fixture(); const read = f.deps.readSource.getMockImplementation()!;
  f.deps.readSource.mockImplementation(async (...args) => { const e = await read(...args); e.candidate.issues.push({ code: "METADATA_CONFLICT", detail: "Unclassified" }); return e; });
  expect(await f.assembly.run(f.join, signal())).toMatchObject({ status: "review", codes: ["LABEL.EVIDENCE_UNCERTAIN", "VALIDATION.FORMULA_MISSING", "VALIDATION.INGREDIENTS_MISSING"] });
});
it("missing packaging evidence cannot silently fall back to the old policy", async () => {
  const f = await fixture(); f.deps.readPackaging.mockRejectedValue(Error("unavailable"));
  expect((await f.assembly.run(f.join, signal())).status).toBe("review"); expect(f.registry.append).not.toHaveBeenCalled();
});
it("packaging re-verification failure after assembly prevents INSERT", async () => {
  const f = await fixture(), out = await f.assembly.run(f.join, signal()); f.deps.readPackaging.mockRejectedValue(Error("missing-original"));
  expect((await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal())).status).toBe("review"); expect(f.registry.append).not.toHaveBeenCalled();
});
it("uncontested count remains 3, with no false conflict warning", async () => {
  const f = await fixture([gncLabelFixture()], ["3"]), out = await f.assembly.run(f.join, signal());
  expect((await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal())).status).toBe("collected");
  const record = [...f.collected.values()][0]!; expect(record.formula.servingsPerContainer!.text).toBe("3"); expect(record.warnings).toEqual([]);
});
it("image-first preserves the established nonblocking container-count policy", async () => {
  const f = await fixture(); f.join.manifest.evidencePolicy = "label-image-first/1";
  const out = await f.assembly.run(f.join, signal()); expect(out.status).toBe("ready");
  expect((await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal())).status).toBe("collected");
  expect([...f.collected.values()][0]!.formula.servingsPerContainer).toBeNull();
});
it.each(["observed", "conflict"])("verified image serving size wins over %s HTML packaging evidence with warnings", async status => {
  const f = await fixture(), document = f.join.manifest.admission!.documents[0]!;
  const values = status === "observed" ? ["9"] : ["9", "10"];
  const facts = PackagingFactsSchema.parse({ ...f.packaging, servingSize: { status, value: status === "observed" ? "9" : null,
    claims: values.map(value => ({ document, field: "servingSize", value, quote: { text: value, start: 0, end: value.length } })) },
    blockingIssues: status === "conflict" ? ["PACKAGING.SERVING_SIZE_CONFLICT"] : [] });
  f.deps.readPackaging.mockResolvedValue(facts);
  expect((await f.assembly.run(f.join, signal())).status).toBe("review");
  f.join.manifest.operationId = "image-first-serving"; f.join.manifest.evidencePolicy = "label-image-first/1";
  const out = await f.assembly.run(f.join, signal()); expect(out.status).toBe("ready");
  expect((await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal())).status).toBe("collected");
  const record = [...f.collected.values()][0]!;
  expect(record.formula.servingSize!.citation.kind).toBe("image");
  expect(record.warnings.some(w => w.code === "PACKAGING.SERVING_SIZE_CONFLICT")).toBe(true);
  expect(LabelCollectedProductSchema.safeParse({ ...record, warnings: record.warnings.filter(w => w.code !== "PACKAGING.SERVING_SIZE_CONFLICT") }).success).toBe(false);
});
it("rejects forged resolved packaging and foreign/duplicate source references", async () => {
  const f = await fixture(); expect(PackagingFactsSchema.safeParse({ ...f.packaging, warnings: [] }).success).toBe(false);
  const foreign = structuredClone(f.join.manifest); foreign.admission!.documents[0]!.listingId = "foreign";
  expect(LabelProductManifestSchema.safeParse(foreign).success).toBe(false);
  const duplicate = structuredClone(f.join.manifest); duplicate.admission!.documents.push(duplicate.admission!.documents[0]!);
  expect(LabelProductManifestSchema.safeParse(duplicate).success).toBe(false);
});
it("persisted /4 refuses invented counts, missing warnings and changed doses", async () => {
  const f = await fixture(), out = await f.assembly.run(f.join, signal()); await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal());
  const record = [...f.collected.values()][0]!;
  const count = structuredClone(record); count.formula.servingsPerContainer = { ...count.formula.servingSize!, text: "12" };
  expect(LabelCollectedProductSchema.safeParse(count).success).toBe(false);
  expect(LabelCollectedProductSchema.safeParse({ ...record, warnings: [] }).success).toBe(false);
  const dose = structuredClone(record); dose.formula.columns[0]!.rows[5]!.amount!.text = "201 mg";
  expect(LabelCollectedProductSchema.safeParse(dose).success).toBe(false);
});
it("explicit typography policy tolerates only harmless typography and preserves both originals", async () => {
  const second = gncLabelFixture(); second.formula!.columns[0]!.heading!.text = "Amount Per Serving";
  second.formula!.columns[0]!.rows[4]!.name.text = "FocusFuel Electrolyte Blend";
  second.formula!.columns[0]!.rows[5]!.amount!.text = "200mg";
  second.formula!.columns[0]!.rows[11]!.name.text = "Lion's Mane";
  const f = await fixture([gncLabelFixture(), second]); f.join.manifest.admission!.comparison = "label-typography/1";
  const out = await f.assembly.run(f.join, signal()); expect(out.status).toBe("ready");
  expect((await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal())).status).toBe("collected");
  const r = [...f.collected.values()][0]!; expect(r).toMatchObject({ comparisonPolicy: "label-typography/1" });
  expect(r.provenance[1]!.candidate.formula!.columns[0]!.rows[5]!.amount!.text).toBe("200mg");
});
it.each(["unit", "dose", "group", "order"])("typography policy still blocks %s changes", async kind => {
  const second = gncLabelFixture(), rows = second.formula!.columns[0]!.rows;
  if (kind === "unit") rows[5]!.amount!.text = "200 mcg";
  if (kind === "dose") rows[5]!.amount!.text = "20 mg";
  if (kind === "group") { rows[17]!.kind = "nutrient"; rows[17]!.parentRowIndex = null; }
  if (kind === "order") [rows[5], rows[6]] = [rows[6]!, rows[5]!];
  const f = await fixture([gncLabelFixture(), second]); f.join.manifest.admission!.comparison = "label-typography/1";
  expect(await f.assembly.run(f.join, signal())).toMatchObject({ status: "review", codes: ["LABEL_PRODUCT.FORMULA_CONFLICT"] });
});
it.each(["Amount Per Serving % DV", "Amounts Per Serving % Daily Value"])("v2 admits adjacent DV heading %s without changing saved fields", async heading => {
  const second = gncLabelFixture(); second.formula!.columns[0]!.heading!.text = heading;
  const old = await fixture([gncLabelFixture(), second]); old.join.manifest.admission!.comparison = "label-typography/1";
  expect(await old.assembly.run(old.join, signal())).toMatchObject({ status: "review", codes: ["LABEL_PRODUCT.FORMULA_CONFLICT"] });
  const f = await fixture([gncLabelFixture(), second]); f.join.manifest.admission!.comparison = "label-typography/2";
  const out = await f.assembly.run(f.join, signal()); expect(out.status).toBe("ready");
  expect((await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal())).status).toBe("collected");
  const record = [...f.collected.values()][0]!;
  expect(record).toMatchObject({ comparisonPolicy: "label-typography/2" });
  expect(record.provenance[1]!.candidate.formula!.columns[0]!.heading!.text).toBe(heading);
});
it.each(["Amount Per Container % DV", "Amount Per 100 g % DV", "Amount Per Serving % DV Children", "unit", "dose", "group", "daily-value"])("v2 still blocks %s differences", async change => {
  const second = gncLabelFixture(), col = second.formula!.columns[0]!;
  if (change === "unit") col.rows[5]!.amount!.text = "200 mcg";
  else if (change === "dose") col.rows[5]!.amount!.text = "20 mg";
  else if (change === "group") { col.rows[17]!.kind = "nutrient"; col.rows[17]!.parentRowIndex = null; }
  else if (change === "daily-value") col.rows[5]!.dailyValue = { text: "99%", evidence: "99%" };
  else col.heading!.text = change;
  const f = await fixture([gncLabelFixture(), second]); f.join.manifest.admission!.comparison = "label-typography/2";
  expect(await f.assembly.run(f.join, signal())).toMatchObject({ status: "review", codes: ["LABEL_PRODUCT.FORMULA_CONFLICT"] });
});
