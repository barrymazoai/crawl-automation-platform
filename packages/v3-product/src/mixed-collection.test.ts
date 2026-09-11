import { it, expect, vi } from "vitest";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { type MixedCollectedProduct, MixedCollectedProductSchema } from "@crawl-automation/v3-contracts";
import { mixedFixture } from "./mixed.fixture.js";
import { CollectMixedProduct, mixedCollectedHash } from "./mixed-collection.js";
const signal = () => new AbortController().signal;
async function setup() {
  const f = await mixedFixture(), outcome = await f.service.run(f.join, signal());
  if (outcome.status !== "ready") throw Error();
  const records = new Map<string, MixedCollectedProduct>();
  const registry = { read: vi.fn(async (id: string) => records.get(id) ?? null), append: vi.fn(async (r: MixedCollectedProduct) => { records.set(r.operationId, r); }) };
  const deps = { assembly: f.service, local: f.local, remote: f.remote, reviews: f.reviews, registry };
  return { ...f, records, registry, deps, collector: new CollectMixedProduct(deps), input: { join: f.join, evidenceKey: outcome.evidenceKey } };
}
it("mixed collection saves both citation kinds without company matching; fresh cache only reads", async () => {
  const f = await setup(), out = await f.collector.run(f.input, signal()); expect(out.status).toBe("collected");
  const r = f.records.get(f.join.manifest.operationId)!; expect(r.codec).toBe("collected-product/2");
  expect(r.ingredients.find(i => i.role === "other")!.name.citations[0]!.kind).toBe("text");
  const puts = f.remote.writes;
  expect(await new CollectMixedProduct({ ...f.deps, local: new MemoryObjects() }).run(f.input, signal())).toEqual(out);
  expect(f.registry.append).toHaveBeenCalledTimes(1); expect(f.remote.writes).toBe(puts); expect(f.calls()).toEqual([1, 1]);
});
it("committed INSERT with lost acknowledgement is confirmed by readback", async () => {
  const f = await setup(); f.registry.append.mockImplementation(async r => { f.records.set(r.operationId, r); throw Error("lost"); });
  expect(await f.collector.run(f.input, signal())).toMatchObject({ status: "collected" }); expect(f.registry.append).toHaveBeenCalledTimes(1);
});
it("unknown INSERT cannot repeat from an empty-cache host", async () => {
  const f = await setup(); f.registry.append.mockRejectedValue(Error("unknown"));
  expect(await f.collector.run(f.input, signal())).toMatchObject({ codes: ["MIXED_COLLECTION.REGISTRATION_UNKNOWN"] });
  expect(await new CollectMixedProduct({ ...f.deps, local: new MemoryObjects() }).run(f.input, signal())).toMatchObject({ codes: ["MIXED_COLLECTION.HANDOFF_PENDING"] });
  expect(f.registry.append).toHaveBeenCalledTimes(1);
});
it("concurrent collectors allow only one INSERT intent owner", async () => {
  const f = await setup();
  await Promise.all([f.collector.run(f.input, signal()), new CollectMixedProduct({ ...f.deps, local: new MemoryObjects() }).run(f.input, signal())]);
  expect(f.registry.append).toHaveBeenCalledTimes(1); expect(f.records.size).toBe(1);
});
it("source corruption before collection prevents INSERT", async () => {
  const f = await setup(); f.remote.data.set(f.source.objectKey, Buffer.from("broken"));
  expect(await f.collector.run(f.input, signal())).toMatchObject({ status: "review" }); expect(f.registry.append).not.toHaveBeenCalled();
});
it("source corruption after an existing collection is not reported as collected", async () => {
  const f = await setup(); await f.collector.run(f.input, signal()); f.remote.data.set(f.source.objectKey, Buffer.from("broken"));
  expect(await f.collector.run(f.input, signal())).toMatchObject({ status: "review" }); expect(f.registry.append).toHaveBeenCalledTimes(1);
});
it("existing conflicting record is never overwritten", async () => {
  const f = await setup(); await f.collector.run(f.input, signal());
  f.records.get(f.join.manifest.operationId)!.formula.servingSize!.text = "conflict";
  expect(await f.collector.run(f.input, signal())).toMatchObject({ codes: ["MIXED_COLLECTION.RESULT_CONFLICT"] }); expect(f.registry.append).toHaveBeenCalledTimes(1);
});
it("failed Review commit cannot be reported as safely queued; lost ack is recoverable", async () => {
  const f = await setup(); f.remote.data.set(f.source.objectKey, Buffer.from("broken"));
  const broken = { ...f.deps, reviews: { read: async () => null, append: async () => { throw Error("fail"); } } };
  await expect(new CollectMixedProduct(broken).run(f.input, signal())).rejects.toThrow("MIXED_COLLECTION.REVIEW_UNVERIFIED");
  f.reviews.lost = true;
  expect(await f.collector.run(f.input, signal())).toMatchObject({ status: "review" });
});
it("mixed snapshot validates citation source ownership and required core fields", async () => {
  const f = await setup(); await f.collector.run(f.input, signal()); const r = f.records.get(f.join.manifest.operationId)!;
  const reverseKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).reverse().map(([k, value]) => [k, reverseKeys(value)])) : v;
  expect(mixedCollectedHash(reverseKeys(r))).toBe(mixedCollectedHash(r));
  const wrong = structuredClone(r); wrong.ingredients[0]!.name.citations[0]!.sourceId = "foreign";
  expect(MixedCollectedProductSchema.safeParse(wrong).success).toBe(false);
  expect(MixedCollectedProductSchema.safeParse({ ...r, formula: null }).success).toBe(false);
  expect(MixedCollectedProductSchema.safeParse({ ...r, ingredients: [] }).success).toBe(false);
});
it("unresolved execution reads durable evidence but rejected receipts never recover to ready", async () => {
  const f = await mixedFixture(); f.join.states = f.join.states.map(s => ({ id: s.id, status: "unresolved" }));
  expect(await f.service.run(f.join, signal())).toMatchObject({ status: "ready" }); expect(f.calls()).toEqual([1, 1]);
  f.join.states[0] = { id: "text", status: "rejected" };
  expect(await f.service.run(f.join, signal())).toMatchObject({ codes: ["MIXED.RECEIPT_INVALID"] });
});
