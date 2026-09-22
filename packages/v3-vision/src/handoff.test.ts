import { expect, it, vi } from "vitest";
import { VisionRecordSchema, type VisionRecord } from "@crawl-automation/v3-contracts";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { VisionHandoff, PostgresVisionRegistry, type VisionRegistry } from "./handoff.js";
import { VisionModule } from "./module.js";
import { selection, bytes, candidate } from "./testing.fixture.js";
import { visionReviewWriter } from "./review.js";
import { CodexError } from "@crawl-automation/v3-codex";

async function setup(raw = JSON.stringify(candidate)) {
  const local = new MemoryObjects(), remote = new MemoryObjects(), records = new Map<string, VisionRecord>();
  const task = { input: { operationId: "vision-1", selection: selection() }, configFingerprint: "a".repeat(64) };
  remote.data.set(task.input.selection.image.objectKey, bytes);
  const provider = { fingerprint: task.configFingerprint, interpret: vi.fn(async () => raw) };
  const registry: VisionRegistry = { read: async id => records.get(id) ?? null, register: async r => { records.set(r.input.operationId, r); } };
  const verify = vi.fn(async () => {});
  const handoff = new VisionHandoff(local, remote, registry, "test/1", verify);
  const module = new VisionModule({ provider, store: remote, localEvidence: local, verifiedOcrText: async () => "Supplement Facts", resolve: async () => bytes });
  await module.run(task.input, AbortSignal.timeout(5000));
  return { task, local, remote, records, provider, registry, verify, handoff };
}
const signal = () => AbortSignal.timeout(5000);
it("registers verified raw result/completion; empty replacement cache inspects without writes/model calls", async () => {
  const f = await setup(), record = await f.handoff.complete(f.task, signal()), before = f.remote.writes;
  expect(record.status).toBe("candidate"); expect(VisionRecordSchema.parse(record)).toEqual(record);
  const replacement = new VisionHandoff(new MemoryObjects(), f.remote, f.registry, "test/1", f.verify);
  expect(await replacement.inspect(f.task, signal())).toEqual(record);
  expect(f.remote.writes).toBe(before); expect(f.provider.interpret).toHaveBeenCalledOnce();
});
it("partial is a registered extraction result, not an ingestion approval", async () => {
  const f = await setup(JSON.stringify({ ...candidate, ingredients: [], ingredientsComplete: false }));
  expect((await f.handoff.complete(f.task, signal())).status).toBe("partial");
});
it("lost PUT acknowledgment is reconciled by GET without repeat PUT", async () => {
  const f = await setup(), before = f.remote.writes; f.remote.unknown = true;
  expect((await f.handoff.complete(f.task, signal())).status).toBe("candidate");
  expect(f.remote.writes).toBe(before + 1);
});
it("lost DB acknowledgment preserves committed registration for read-only inspection", async () => {
  const f = await setup(), original = f.registry.register;
  f.registry.register = async r => { await original(r); throw Error("lost acknowledgment"); };
  await expect(f.handoff.complete(f.task, signal())).rejects.toThrow("lost acknowledgment");
  const before = f.remote.writes;
  expect(await f.handoff.inspect(f.task, signal())).not.toBeNull(); expect(f.remote.writes).toBe(before);
});
it.each(["image", "response", "completion"])("rejects corrupt %s on registered replay", async what => {
  const f = await setup(), r = await f.handoff.complete(f.task, signal());
  const key = what === "image" ? f.task.input.selection.image.objectKey : what === "response" ? r.result.objectKey : r.completion.objectKey;
  f.remote.data.set(key, Buffer.from("corrupt"));
  await expect(f.handoff.inspect(f.task, signal())).rejects.toThrow(); expect(f.provider.interpret).toHaveBeenCalledOnce();
});
it("rejects wrong configuration, source identity, or storage scope", async () => {
  const f = await setup(); await f.handoff.complete(f.task, signal());
  await expect(f.handoff.inspect({ ...f.task, configFingerprint: "b".repeat(64) }, signal())).rejects.toThrow();
  const other = new VisionHandoff(f.local, f.remote, f.registry, "other/1", f.verify);
  await expect(other.inspect(f.task, signal())).rejects.toThrow();
  f.verify.mockRejectedValueOnce(Error("OCR no longer verified"));
  await expect(f.handoff.inspect(f.task, signal())).rejects.toThrow();
});
it("Postgres codec survives jsonb ordering, rejects tampering and cross-codec records", async () => {
  const f = await setup(), r = await f.handoff.complete(f.task, signal()); let row: Record<string, unknown> | undefined;
  const reorder = (v: unknown): unknown => Array.isArray(v) ? v.map(reorder) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorder(x)])) : v;
  const db = { query: async (sql: string, args?: unknown[]) => {
    if (sql.startsWith("INSERT")) row ??= { record: reorder(JSON.parse(args![2] as string)), record_hash: args![1] };
    return { rows: row ? [row] : [] };
  } };
  const registry = new PostgresVisionRegistry(db); await registry.register(r);
  expect(await registry.read(r.input.operationId)).toEqual(r);
  row!.record_hash = "b".repeat(64); await expect(registry.read(r.input.operationId)).rejects.toThrow();
  row!.record = { schemaVersion: 1, codec: "ocr-result/1" }; await expect(registry.read(r.input.operationId)).rejects.toThrow();
});
it("Review is locally retained before append and contains passive error evidence", async () => {
  const f = await setup(); let record: unknown;
  const append = vi.fn(async r => { record = r; expect([...f.local.data.keys()].some(k => k.startsWith("vision-reviews/"))).toBe(true); return { reviewId: r.reviewId, recordHash: "a".repeat(64), registered: true }; });
  const result = await visionReviewWriter(f.local, { append })(f.task, { status: "review", code: "VISION.HANDOFF_PENDING", candidate,
    evidenceKey: "v3/vision/vision-1/response.json", replayed: false, automaticRetry: false }, signal());
  expect(Object.keys(result)).toEqual(["reviewId"]);
  expect(result.reviewId).toMatch(/^vision-/); expect(record).toMatchObject({ failure: { automaticRetry: false, executionFact: "executed" } });
});
it("a failed turn's reason survives into its failure evidence, its replay, and its Review", async () => {
  const local = new MemoryObjects(), remote = new MemoryObjects();
  const task = { input: { operationId: "vision-2", selection: selection() }, configFingerprint: "a".repeat(64) };
  remote.data.set(task.input.selection.image.objectKey, bytes);
  const provider = { fingerprint: task.configFingerprint,
    interpret: vi.fn(async () => { throw new CodexError("VISION.CODEX_TURN_FAILED", "unknown", "unexpected status 429 | usageLimitExceeded"); }) };
  const make = () => new VisionModule({ provider, store: remote, localEvidence: local, verifiedOcrText: async () => "Supplement Facts", resolve: async () => bytes });
  const first = await make().run(task.input, signal());
  expect(first).toMatchObject({ status: "review", code: "VISION.CODEX_TURN_FAILED", detail: "unexpected status 429 | usageLimitExceeded" });
  expect(JSON.parse(Buffer.from(local.data.get("v3/vision/vision-2/failure.json")!).toString()).detail).toBe("unexpected status 429 | usageLimitExceeded");
  const replay = await make().run(task.input, signal());
  expect(replay).toMatchObject({ replayed: true, code: "VISION.CODEX_TURN_FAILED", detail: "unexpected status 429 | usageLimitExceeded" });
  expect(provider.interpret).toHaveBeenCalledOnce(); // the reason never buys a second model call
  let record: any;
  await visionReviewWriter(local, { append: async r => { record = r; return { reviewId: r.reviewId }; } })(task, first, signal());
  expect(record.rawError.details.cause).toBe("unexpected status 429 | usageLimitExceeded");
});
it("failure evidence written before the reason existed still replays", async () => {
  const local = new MemoryObjects(), remote = new MemoryObjects();
  const task = { input: { operationId: "vision-3", selection: selection() }, configFingerprint: "a".repeat(64) };
  remote.data.set(task.input.selection.image.objectKey, bytes);
  const provider = { fingerprint: task.configFingerprint, interpret: vi.fn(async () => { throw new CodexError("VISION.CODEX_TURN_FAILED"); }) };
  const make = () => new VisionModule({ provider, store: remote, localEvidence: local, verifiedOcrText: async () => "Supplement Facts", resolve: async () => bytes });
  const first = await make().run(task.input, signal());
  expect(first).not.toHaveProperty("detail");
  expect(await make().run(task.input, signal())).toMatchObject({ replayed: true, code: "VISION.CODEX_TURN_FAILED" });
});
