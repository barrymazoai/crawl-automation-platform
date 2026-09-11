import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@temporalio/activity";
import { parseWorkerConfig } from "../../v3-worker-runtime/src/config.js";
import { RoleRegistry } from "../../v3-worker-runtime/src/registry.js";
import { labelExecutionFixture } from "./label-execution.fixture.js";
import { createKeywordRole, createVisionRole } from "./roles.js";
import { observation, bytes, candidate, selection } from "./testing.fixture.js";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { VisionHandoff, type VisionRegistry } from "./handoff.js";
afterEach(() => vi.restoreAllMocks());
const base = { buildId: "a".repeat(64), compatibility: "fixture-v1", testOnly: true };
const config = parseWorkerConfig({ role: "codex-vision", capability: "codex.vision", contractVersion: 1, compatibility: base.compatibility,
  expectedBuildId: base.buildId, hostId: "test", namespace: "default", address: "127.0.0.1:7233", transport: { mode: "local" }, testSession: "test" });
const signal = () => new AbortController().signal;
function context(attempt: number) { return vi.spyOn(Context, "current").mockReturnValue({ info: { attempt }, heartbeat() {}, cancellationSignal: signal() } as unknown as Context); }
it("new protocol Activity registers reference-only receipt; cold redelivery creates no model, upload or registration", async () => {
  const f = labelExecutionFixture(), review = vi.fn(async () => ({ reviewId: "review-1" }));
  const role = createVisionRole({ ...base, compatibility: `vision-${f.task.configFingerprint.slice(0, 32)}`,
    prepare: async () => ({ dispose: async () => {}, dependencies: f.dependencies, handoff: f.handoff, recordReview: review }) });
  const p = await role.prepare({ ...config, compatibility: role.compatibility }, signal());
  if (p.kind !== "activity") throw Error(); context(1);
  const first = await p.activities.interpretImage!(f.task);
  expect(first).toEqual({ status: "registered", candidateStatus: "candidate", operationId: f.task.input.operationId,
    evidenceKey: `v3/vision/${f.task.input.operationId}/response.json` });
  f.local.data.clear(); const writes = f.remote.writes;
  expect(await p.activities.interpretImage!(f.task)).toEqual(first);
  expect(f.provider.interpret).toHaveBeenCalledOnce(); expect(f.registry.register).toHaveBeenCalledOnce();
  expect(f.remote.writes).toBe(writes); expect(review).not.toHaveBeenCalled();
});
it("new protocol Activity retains computed evidence on unavailable registration and does not retry it", async () => {
  const f = labelExecutionFixture(), review = vi.fn(async () => ({ reviewId: "review-1" }));
  f.registry.register = vi.fn(async () => { throw Error("unavailable"); });
  const role = createVisionRole({ ...base, prepare: async () => ({ dispose: async () => {}, dependencies: f.dependencies,
    handoff: f.handoff, recordReview: review }) });
  const p = await role.prepare(config, signal()); if (p.kind !== "activity") throw Error(); context(1);
  expect(await p.activities.interpretImage!(f.task)).toMatchObject({ status: "review", code: "VISION.HANDOFF_PENDING" });
  const writes = f.remote.writes;
  expect(await p.activities.interpretImage!(f.task)).toMatchObject({ status: "review", code: "VISION.HANDOFF_PENDING" });
  expect(f.registry.register).toHaveBeenCalledOnce(); expect(f.provider.interpret).toHaveBeenCalledOnce(); expect(f.remote.writes).toBe(writes);
});
it("keyword Activity publishes before returning and contains no raw OCR text", async () => {
  const published = vi.fn(async () => ({ evidenceKey: "keyword/result.json" }));
  const role = createKeywordRole({ ...base, prepare: async () => ({ evidence: { screen: async () => selection("marketing") }, publish: published,
    recordReview: async () => ({ reviewId: "review-1" }), dispose: async () => {} }) });
  const p = await role.prepare(config, signal()); if (p.kind !== "activity") throw Error();
  const ctx = context(2); await expect(p.activities.screenImageKeywords!({})).rejects.toMatchObject({ nonRetryable: true });
  expect(published).not.toHaveBeenCalled(); ctx.mockReturnValue({ info: { attempt: 1 }, heartbeat() {}, cancellationSignal: signal() } as unknown as Context);
  expect(await p.activities.screenImageKeywords!({})).toEqual({ status: "not_matched", imageId: selection().image.artifactId, selection: selection("marketing"), evidenceKey: "keyword/result.json" });
  expect(published).toHaveBeenCalledOnce();
  expect(() => new RoleRegistry("business", [role])).toThrow();
});
it("keyword publication failure cannot report successful no-match", async () => {
  const role = createKeywordRole({ ...base, prepare: async () => ({ evidence: { screen: async () => selection("marketing") },
    publish: async () => { throw Error("private failure"); }, recordReview: async () => ({ reviewId: "review-1" }), dispose: async () => {} }) });
  const p = await role.prepare(config, signal()); if (p.kind !== "activity") throw Error(); context(1);
  expect(await p.activities.screenImageKeywords!({})).toMatchObject({ status: "review", code: "SCREEN.EVIDENCE_UNRESOLVED", reviewId: "review-1" });
});
it("vision Activity emits a small evidence receipt, rejects retries, and persists Review through its adapter", async () => {
  const objects = new Map<string, Uint8Array>(); let calls = 0;
  const store: ObjectStore = { read: async k => objects.get(k) ?? null,
    create: async (k, b) => { if (objects.has(k)) return "exists"; objects.set(k, b); return "created"; } };
  const review = vi.fn(async () => ({ reviewId: "review-1" }));
  const registry: VisionRegistry = { read: async () => null, register: async () => {} };
  const handoff = new VisionHandoff(store, store, registry, "test/1", async () => {});
  const role = createVisionRole({ ...base, prepare: async () => ({ dispose: async () => {}, recordReview: review,
    handoff,
    dependencies: { store, localEvidence: store, resolve: async () => bytes, verifiedOcrText: async () => "Supplement Facts",
      provider: { fingerprint: "a".repeat(64), interpret: async () => { calls++; return JSON.stringify(candidate); } } } }) });
  const p = await role.prepare(config, signal()); if (p.kind !== "activity") throw Error();
  const ctx = context(2), input = { input: { operationId: "vision-1", selection: selection() }, configFingerprint: "a".repeat(64) };
  await expect(p.activities.interpretImage!(input)).rejects.toMatchObject({ nonRetryable: true }); expect(calls).toBe(0);
  ctx.mockReturnValue({ info: { attempt: 1 }, heartbeat() {}, cancellationSignal: signal() } as unknown as Context);
  const result = await p.activities.interpretImage!(input); expect(result).toMatchObject({ status: "review", code: "VISION.HANDOFF_PENDING" }); expect(calls).toBe(1);
  objects.delete("v3/vision/vision-1/response.json");
  expect(await p.activities.interpretImage!(input)).toMatchObject({ status: "review", code: "VISION.EXECUTION_UNKNOWN", reviewId: "review-1", automaticRetry: false });
  expect(review).toHaveBeenCalledTimes(2); expect(calls).toBe(1); expect(observation.requestId).toBeDefined();
});
