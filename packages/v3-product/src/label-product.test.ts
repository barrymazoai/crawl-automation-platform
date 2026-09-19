import { expect, it, vi } from "vitest";
import { LabelProductJoinSchema, LabelCollectedProductSchema, ReviewRecordSchema } from "@crawl-automation/v3-contracts";
import { visionFingerprint } from "@crawl-automation/v3-vision";
import { gncLabelFixture } from "../../v3-contracts/src/label.fixture.js";
import { labelProductFixture } from "./label-product.fixture.js";
import { labelAssemblyKey, labelCollectedHash, PostgresLabelCollectedProducts } from "./label-product.js";
const signal = () => new AbortController().signal;
it("optional source identity mismatch is never downgraded to a warning", async () => {
  const f = await labelProductFixture(); f.join.manifest.sources[0]!.required = false;
  const original = f.deps.readSource.getMockImplementation()!;
  f.deps.readSource.mockImplementation(async (...args) => ({ ...await original(...args), id: "foreign" }));
  expect(await f.assembly.run(f.join, signal())).toMatchObject({ status: "review", codes: ["LABEL_PRODUCT.IDENTITY_CONFLICT"] });
  expect(f.registry.append).not.toHaveBeenCalled();
});
it("preserves duplicate group names, row coordinates, component doses and all provenance in /3", async () => {
  const f = await labelProductFixture(), out = await f.assembly.run(f.join, signal());
  expect(out.status).toBe("ready");
  const result = await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal());
  expect(result.status).toBe("collected"); const r = [...f.collected.values()][0]!;
  expect(r.codec).toBe("collected-product/3"); expect(r.formula.columns[0]!.rows).toHaveLength(18);
  expect(r.ingredients.filter(i => i.role === "blend_component")).toHaveLength(11);
  expect(r.ingredients.filter(i => i.role === "other")).toHaveLength(7);
  expect(r.ingredients.find(i => i.name.text === "Sodium")).toMatchObject({ parentRowIndex: 4, amount: { text: "200 mg" } });
  expect(r.ingredients.find(i => i.name.text.startsWith("Natural Caffeine"))).toMatchObject({ parentRowIndex: 13, amount: { text: "100 mg" } });
  expect(r.provenance[0]!.candidate).toEqual(gncLabelFixture());
  const writes = f.remote.writes, calls = f.inputs[0]!.provider.interpret.mock.calls.length;
  expect(await f.cold().collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal())).toEqual(result);
  expect(f.registry.append).toHaveBeenCalledTimes(1); expect(f.remote.writes).toBe(writes); expect(f.inputs[0]!.provider.interpret).toHaveBeenCalledTimes(calls);
});
it("formula-only and ingredients-only independent candidates can complement; order is canonical", async () => {
  const formula = gncLabelFixture(); formula.otherIngredients = null;
  const ingredients = gncLabelFixture(); ingredients.formula = null; ingredients.formulaComplete = false;
  const f = await labelProductFixture([formula, ingredients]);
  const out = await f.assembly.run(f.join, signal()); expect(out.status).toBe("ready");
  const reverse = { manifest: { ...f.join.manifest, sources: [...f.join.manifest.sources].reverse() }, states: [...f.join.states].reverse() };
  const writes = f.remote.writes; expect(await f.cold().assembly.run(reverse, signal())).toEqual(out); expect(f.remote.writes).toBe(writes);
  expect((await f.collector.run({ join: reverse, evidenceKey: out.evidenceKey }, signal())).status).toBe("collected");
});
it.each(["amount", "ingredients", "container"])("valid %s disagreement is Review, even for optional sources", async kind => {
  const other = gncLabelFixture();
  if (kind === "amount") other.formula!.columns[0]!.rows[5]!.amount!.text = "201 mg";
  if (kind === "ingredients") other.otherIngredients!.items[0]!.text = "Different syrup";
  if (kind === "container") other.formula!.servingsPerContainer!.text = "12";
  const f = await labelProductFixture([gncLabelFixture(), other]); f.join.manifest.sources[1]!.required = false;
  const out = await f.assembly.run(f.join, signal()); expect(out.status).toBe("review");
  expect((await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal())).status).toBe("review");
  expect(f.collected.size).toBe(0);
});
it("required source Review blocks; optional failure remains a warning without rerunning source", async () => {
  const f = await labelProductFixture([gncLabelFixture(), gncLabelFixture()]), source = f.join.manifest.sources[1]!;
  if (source.kind !== "image") throw Error();
  const r = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: "source-review", occurredAt: "2026-09-07T00:00:00Z", observation: f.join.manifest.observation,
    failure: { schemaVersion: 1, requestId: f.join.manifest.observation.requestId, observationId: f.join.manifest.observation.observationId,
      operationId: source.task.input.operationId, inputFingerprint: visionFingerprint(source.task), stage: "codex.vision", category: "PROCESSING", code: "VISION.UNCERTAIN",
      executionFact: "executed", evidenceKey: "retained/response.json", blockedBy: null, automaticRetry: false },
    rawError: { name: "Synthetic", message: "Synthetic", stack: null, details: null }, candidate: null, inspection: { kind: "none" } });
  f.records.set(r.reviewId, r); f.join.states[1] = { id: source.id, status: "review", reviewId: r.reviewId };
  expect(await f.assembly.run(f.join, signal())).toMatchObject({ status: "review", codes: ["VISION.UNCERTAIN"] });
  const next = structuredClone(f.join); next.manifest.operationId = "optional-product"; next.manifest.sources[1]!.required = false;
  const out = await f.assembly.run(next, signal()); expect(out.status).toBe("ready");
  expect(await f.collector.run({ join: next, evidenceKey: out.evidenceKey }, signal())).toMatchObject({ status: "collected" });
  expect([...f.collected.values()][0]!.warnings).toEqual([{ id: source.id, code: "VISION.UNCERTAIN" }]);
});
it.each(["missing", "duplicate", "foreign"])("rejects %s terminal state without collection", async kind => {
  const f = await labelProductFixture();
  if (kind === "missing") f.join.states = [];
  if (kind === "duplicate") f.join.states.push(f.join.states[0]!);
  if (kind === "foreign") f.join.states[0]!.id = "foreign";
  expect((await f.assembly.run(f.join, signal())).status).toBe("review"); expect(f.registry.append).not.toHaveBeenCalled();
});
it("retained source corruption blocks collection without repairing or calling the model", async () => {
  const f = await labelProductFixture(), out = await f.assembly.run(f.join, signal());
  f.inputs[0]!.remote.data.set(f.inputs[0]!.task.input.selection.image.objectKey, Buffer.from("corrupted"));
  expect((await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal())).status).toBe("review");
  expect(f.registry.append).not.toHaveBeenCalled(); expect(f.inputs[0]!.provider.interpret).toHaveBeenCalledTimes(1);
});
it("unknown assembly upload remains Review on an empty cache with no second PUT", async () => {
  const f = await labelProductFixture(), key = labelAssemblyKey(f.join), create = f.remote.create.bind(f.remote);
  const writes = vi.spyOn(f.remote, "create").mockImplementation(async (...args) => { if (args[0] === key) throw Error("secret"); return create(...args); });
  expect((await f.assembly.run(f.join, signal())).status).toBe("review"); const count = writes.mock.calls.length;
  expect(await f.cold().assembly.run(f.join, signal())).toMatchObject({ status: "review", codes: ["LABEL_PRODUCT.HANDOFF_PENDING"] });
  expect(writes).toHaveBeenCalledTimes(count); expect(JSON.stringify([...f.records.values()])).not.toContain("secret");
});
it("lost assembly acknowledgement and collection acknowledgement resolve by readback", async () => {
  const f = await labelProductFixture(), key = labelAssemblyKey(f.join), create = f.remote.create.bind(f.remote);
  vi.spyOn(f.remote, "create").mockImplementation(async (...args) => { const out = await create(...args); if (args[0] === key) throw Error("lost"); return out; });
  const out = await f.assembly.run(f.join, signal()); expect(out.status).toBe("ready");
  f.registry.append.mockImplementation(async r => { f.collected.set(r.operationId, r); throw Error("lost"); });
  expect((await f.collector.run({ join: f.join, evidenceKey: key }, signal())).status).toBe("collected"); expect(f.registry.append).toHaveBeenCalledTimes(1);
});
it("unknown INSERT is not repeated by a replacement", async () => {
  const f = await labelProductFixture(), out = await f.assembly.run(f.join, signal()); f.registry.append.mockRejectedValue(Error("unavailable"));
  const input = { join: f.join, evidenceKey: out.evidenceKey };
  expect((await f.collector.run(input, signal())).status).toBe("review"); const writes = f.remote.writes;
  expect(await f.cold().collector.run(input, signal())).toMatchObject({ status: "review", codes: ["LABEL_PRODUCT.HANDOFF_PENDING"] });
  expect(f.registry.append).toHaveBeenCalledTimes(1); expect(f.remote.writes).toBe(writes);
});
it("duplicate concurrent collectors insert at most once", async () => {
  const f = await labelProductFixture(), out = await f.assembly.run(f.join, signal()), input = { join: f.join, evidenceKey: out.evidenceKey };
  const results = await Promise.all([f.collector.run(input, signal()), f.cold().collector.run(input, signal())]);
  expect(results.some(r => r.status === "collected")).toBe(true); expect(f.registry.append).toHaveBeenCalledTimes(1);
});
it("cancellation does not write or create a new Review", async () => {
  const f = await labelProductFixture();
  await expect(f.assembly.run(f.join, AbortSignal.abort(Error("cancelled")))).rejects.toThrow("cancelled");
  expect(f.remote.writes).toBe(0); expect(f.records.size).toBe(0);
});
it("a source Review the ledger never received is still accounted for, not thrown away", async () => {
  const f = await labelProductFixture();
  // A cloud worker has no ledger of its own: its Review exists only in the retained copy until something registers
  // it, and vision has no receipt step at all. The consumer is given a reader that falls back to that copy.
  const source = f.join.manifest.sources[0]!;
  const record = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: "vision-only-retained", occurredAt: new Date().toISOString(),
    failure: { schemaVersion: 1, requestId: f.join.manifest.observation.requestId, observationId: f.join.manifest.observation.observationId,
      operationId: source.kind === "text" ? source.task.operationId : source.task.input.operationId,
      inputFingerprint: source.kind === "text" ? source.task.inputFingerprint : visionFingerprint(source.task),
      stage: source.kind === "text" ? "codex.text" : "codex.vision", category: "PROCESSING", code: "VISION.LABEL_CORE_MISSING",
      executionFact: "executed", evidenceKey: "v3/vision/retained.json", blockedBy: null, automaticRetry: false },
    observation: f.join.manifest.observation, rawError: { name: "VisionReview", message: "VISION.LABEL_CORE_MISSING", stack: null, details: {} },
    candidate: null, inspection: { kind: "none" } });
  const retained = new Map([[record.reviewId, record]]);
  const ledger = f.deps.reviews.read.getMockImplementation()!;
  f.deps.reviews.read.mockImplementation(async (id: string) => (await ledger(id)) ?? retained.get(id) ?? null);
  f.join.states = f.join.manifest.sources.map((x, i) => i === 0 ? { id: x.id, status: "review", reviewId: record.reviewId } : { id: x.id, status: "registered" });
  const out = await f.assembly.run(f.join, signal());
  // The product is accounted for on the real reason, instead of dying because the record was not in the ledger.
  expect(out.status).toBe("review");
  expect(JSON.stringify(out)).not.toContain("LABEL_PRODUCT.REVIEW_UNVERIFIED");
});
it("refuses fake Review confirmation", async () => {
  const f = await labelProductFixture(); f.join.states = []; f.deps.reviews.append.mockResolvedValue(undefined);
  await expect(f.assembly.run(f.join, signal())).rejects.toThrow("LABEL_PRODUCT.REVIEW_UNVERIFIED");
});
it("shared contracts reject codec/owner mix and ingredient coordinate tampering", async () => {
  const f = await labelProductFixture(), out = await f.assembly.run(f.join, signal()); await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal());
  const record = structuredClone([...f.collected.values()][0]!); record.ingredients[0]!.parentRowIndex = 13;
  expect(LabelCollectedProductSchema.safeParse(record).success).toBe(false);
  const foreign = structuredClone(f.join); foreign.manifest.observation.variantId = "foreign";
  expect(LabelProductJoinSchema.safeParse(foreign).success).toBe(false);
});
it("JSONB key order does not change record hash; a mismatched database hash fails", async () => {
  const f = await labelProductFixture(), out = await f.assembly.run(f.join, signal()); await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal());
  const r = [...f.collected.values()][0]!, shuffled = (v: any): any => Array.isArray(v) ? v.map(shuffled) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, shuffled(x)])) : v;
  const row = { record: shuffled(r), record_hash: labelCollectedHash(r), observation_id: r.observation.observationId };
  const db = new PostgresLabelCollectedProducts({ query: async () => ({ rows: [row] }) });
  expect(await db.read(r.operationId)).toEqual(r); row.record_hash = "0".repeat(64);
  await expect(db.read(r.operationId)).rejects.toThrow("LABEL_COLLECTION.INTEGRITY");
});
