import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { ResourceRecovery, restoreComputedHandoff, type RecoveryEvidence } from "./resource-recovery.js";
import { MemoryObjects, MemoryRegistry, setup, signal } from "../../v3-results/src/testing.fixture.js";
import { OcrResultHandoff } from "../../v3-results/src/handoff.js";
import { FileCompletionJournal } from "../../v3-results/src/file-journal.js";
import { fixture as textFixture } from "../../v3-text/src/testing.fixture.js";
import { TextHandoff } from "../../v3-text/src/handoff.js";
import { labelExecutionFixture } from "../../v3-vision/src/label-execution.fixture.js";
import { VisionHandoff } from "../../v3-vision/src/handoff.js";
import { join } from "node:path";

function recoveryFixture() {
  const request = { permitId: "permit-test", workflowId: "workflow-test", runId: randomUUID(), needs: [{ resourceId: "cpu", units: 1 }] };
  let released = false; const store = new MemoryObjects();
  const historyBytes = Buffer.from('{"fixture":true}');
  const evidence: RecoveryEvidence = { status: "verified", historyBytes, proof: { codec: "resource-release-proof/1", namespace: "isolated-test", request,
    historySha256: sha256(historyBytes), workflowBundleSha256: "a".repeat(64), grantEventId: 3, releaseIntentEventId: 7, terminalEventId: 8,
    verifiedEffects: [{ activityId: "activity-test", activityType: "ocrFile", scheduledEventId: 4, completedEventId: 6 }] } };
  const ledger = { read: vi.fn(async () => ({ request, released })), release: vi.fn(async () => { expect(store.data.size).toBe(2); released = true; }) };
  const inspect = vi.fn(async (): Promise<RecoveryEvidence> => evidence);
  return { request, ledger, inspect, store, evidence, recovery: new ResourceRecovery(ledger, inspect, store) };
}
it("audit has no writes; apply retains full history and proof before release; rerun does not inspect/execute", async () => {
  const f = recoveryFixture(); expect((await f.recovery.run(f.request.permitId, false, signal())).status).toBe("recoverable");
  expect(f.store.writes).toBe(0); expect(f.ledger.release).not.toHaveBeenCalled();
  expect((await f.recovery.run(f.request.permitId, true, signal())).status).toBe("released");
  expect((await new ResourceRecovery(f.ledger, f.inspect, f.store).run(f.request.permitId, true, signal())).status).toBe("already_released");
  expect(f.inspect).toHaveBeenCalledTimes(2); expect(f.ledger.release).toHaveBeenCalledOnce(); expect(f.store.writes).toBe(2);
});
it("lost proof PUT and SQL release acknowledgement are verified by readback", async () => {
  const f = recoveryFixture(); f.store.unknown = true; const release = f.ledger.release.getMockImplementation()!;
  f.ledger.release.mockImplementation(async () => { await release(); throw Error("lost reply"); });
  expect((await f.recovery.run(f.request.permitId, true, signal())).status).toBe("released"); expect(f.store.writes).toBe(2);
});
it("parallel recoveries retain identical immutable proof", async () => {
  const f = recoveryFixture(); const results = await Promise.all(Array.from({ length: 8 }, () => f.recovery.run(f.request.permitId, true, signal())));
  expect(results.every(r => ["released", "already_released"].includes(r.status))).toBe(true); expect(f.store.data.size).toBe(2);
});
it("unknown original execution stays quarantined without retention/release", async () => {
  const f = recoveryFixture(); f.inspect.mockResolvedValue({ status: "quarantined", code: "RESOURCE_RECOVERY.EXECUTION_UNCONFIRMED" });
  expect((await f.recovery.run(f.request.permitId, true, signal())).status).toBe("quarantined"); expect(f.store.writes).toBe(0); expect(f.ledger.release).not.toHaveBeenCalled();
});
it.each(["missing", "corrupt", "unavailable"])("%s retained evidence never releases", async kind => {
  const f = recoveryFixture();
  f.store.create = async (key, bytes) => { if (kind === "unavailable") throw Error("offline"); if (kind === "corrupt") f.store.data.set(key, Buffer.from("corrupt")); return "created"; };
  expect((await f.recovery.run(f.request.permitId, true, signal())).status).toBe("quarantined"); expect(f.ledger.release).not.toHaveBeenCalled();
});
it("identity conflict rejects proof without SQL mutation", async () => {
  const f = recoveryFixture(); if (f.evidence.status === "verified") f.evidence.proof.request = { ...f.request, runId: randomUUID() };
  await expect(f.recovery.run(f.request.permitId, true, signal())).rejects.toThrow("IDENTITY_CONFLICT"); expect(f.ledger.release).not.toHaveBeenCalled();
});
it("uncommitted release remains quarantined with retained proof", async () => {
  const f = recoveryFixture(); f.ledger.release.mockRejectedValue(Error("offline"));
  expect(await f.recovery.run(f.request.permitId, true, signal())).toMatchObject({ status: "quarantined", code: "RESOURCE_RECOVERY.RELEASE_UNCONFIRMED" }); expect(f.store.data.size).toBe(2);
});
it("Review is never promoted even with completed bytes", async () => {
  const p = { reviewed: vi.fn(async () => true), inspect: vi.fn(), upload: vi.fn(), register: vi.fn() };
  expect((await restoreComputedHandoff(p, true)).code).toBe("RESOURCE_RECOVERY.REVIEW_PRESERVED"); expect(p.inspect).not.toHaveBeenCalled();
});
it("new Review between inspection and registration prevents registration", async () => {
  const p = { reviewed: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true), inspect: vi.fn(async () => ({ computed: true, durable: true, registered: false })), upload: vi.fn(), register: vi.fn() };
  expect((await restoreComputedHandoff(p, true)).code).toBe("RESOURCE_RECOVERY.REVIEW_PRESERVED"); expect(p.register).not.toHaveBeenCalled();
});
it("reopened OCR journal repairs upload/registration with lost replies; no OCR port exists", async () => {
  const registry = new MemoryRegistry(), f = await setup(registry); await f.handoff.capture(f.input, f.output, signal());
  const h = new OcrResultHandoff("fixture-r2/1", f.local, f.remote, await FileCompletionJournal.open(join(f.root, "journal")), registry);
  const p = { reviewed: async () => false, inspect: async () => { const x = await h.inspect(f.input, signal()); return { computed: x.computedLocal, durable: x.artifactDurable, registered: x.resultRegistered }; }, upload: () => h.uploadMissing(f.input, signal()), register: () => h.register(f.input, signal()) };
  expect((await restoreComputedHandoff(p, false)).status).toBe("recoverable"); f.remote.unknown = true; registry.loseAfterCommit = true;
  expect((await restoreComputedHandoff(p, true)).status).toBe("registered"); const writes = f.remote.writes;
  expect((await restoreComputedHandoff(p, true)).status).toBe("registered"); expect(f.remote.writes).toBe(writes); expect(registry.writes).toBe(1);
});
it("typed text result without completion journal recovers original provider without model rerun", async () => {
  const f = textFixture(); await f.module.run(f.input, signal()); expect(f.calls()).toBe(1);
  const record = f.registry.data.get(f.input.operationId)!; const original = JSON.parse(Buffer.from(f.local.data.get(record.result.objectKey)!).toString());
  f.registry.data.clear(); f.local.data.delete(f.handoff.journalKey(f.input)); f.local.data.delete(record.completion.objectKey);
  f.remote.data.delete(record.result.objectKey); f.remote.data.delete(record.completion.objectKey);
  const h = new TextHandoff(f.local, f.remote, f.registry, f.evidence, "fixture/1");
  const p = { reviewed: async () => false, inspect: () => h.inspectRecovery(f.input, signal()), upload: () => h.uploadRecoveredResponse(f.input, signal()), register: () => h.register(f.input, signal()) };
  expect((await restoreComputedHandoff(p, true)).status).toBe("registered"); expect(f.calls()).toBe(1);
  expect(JSON.parse(Buffer.from(f.remote.data.get(record.result.objectKey)!).toString()).provider).toBe(original.provider);
});
it("raw text response alone cannot invent typed completion/provider metadata", async () => {
  const f = textFixture(); await f.handoff.retainResponse(f.input, "{}");
  await expect(f.handoff.inspectRecovery(f.input, signal())).rejects.toThrow(); expect(f.calls()).toBe(0); expect(f.registry.data.size).toBe(0);
});
it("vision local response survives missing remote publication and repairs handoff without model rerun", async () => {
  const f = labelExecutionFixture(); await f.module.run(f.task.input, signal());
  const key = `v3/vision/${f.task.input.operationId}/response.json`; f.remote.data.delete(key);
  const h = new VisionHandoff(f.local, f.remote, f.registry, "test/1", f.verify);
  const p = { reviewed: async () => false, inspect: () => h.inspectRecovery(f.task, signal()), upload: () => h.uploadRecoveredResponse(f.task, signal()), register: () => h.complete(f.task, signal()) };
  expect(await p.inspect()).toEqual({ computed: true, durable: false, registered: false });
  expect((await restoreComputedHandoff(p, true)).status).toBe("registered"); expect(f.provider.interpret).toHaveBeenCalledOnce(); expect(f.records.size).toBe(1);
  expect((await restoreComputedHandoff(p, true)).status).toBe("registered"); expect(f.provider.interpret).toHaveBeenCalledOnce();
});
it("corrupt vision local response is not uploaded", async () => {
  const f = labelExecutionFixture(); await f.module.run(f.task.input, signal()); const key = `v3/vision/${f.task.input.operationId}/response.json`;
  f.remote.data.delete(key); f.local.data.set(key, Buffer.from("corrupt")); const writes = f.remote.writes;
  await expect(f.handoff.uploadRecoveredResponse(f.task, signal())).rejects.toThrow(); expect(f.remote.writes).toBe(writes); expect(f.records.size).toBe(0);
});
