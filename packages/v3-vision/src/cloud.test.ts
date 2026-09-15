import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ArtifactResolver } from "@crawl-automation/v3-artifacts";
import { observationIdentity, type VisionRecord } from "@crawl-automation/v3-contracts";
import { OcrResultHandoff } from "@crawl-automation/v3-results";
import { MemoryObjects, setup as ocrSetup } from "../../v3-results/src/testing.fixture.js";
import { VisionHandoff, type VisionRegistry } from "./handoff.js";
import { VisionModule } from "./module.js";
import { RemoteOcrEvidence } from "./ocr-evidence.js";
import { screenKeywords } from "./keywords.js";
import { selection, bytes, candidate } from "./testing.fixture.js";

const signal = () => AbortSignal.timeout(5000);
async function setup() {
  const local = new MemoryObjects(), remote = new MemoryObjects();
  const task = { input: { operationId: "vision-cloud-1", selection: selection() }, configFingerprint: "a".repeat(64) };
  remote.data.set(task.input.selection.image.objectKey, bytes);
  const provider = { fingerprint: task.configFingerprint, interpret: vi.fn(async () => JSON.stringify(candidate)) };
  const module = new VisionModule({ provider, store: remote, localEvidence: local, verifiedOcrText: async () => "Supplement Facts", resolve: async () => bytes });
  const outcome = await module.run(task.input, signal());
  const verify = vi.fn(async () => {});
  return { task, local, remote, provider, outcome, verify, cloud: new VisionHandoff(local, remote, null, "test/1", verify) };
}
function mini(f: Awaited<ReturnType<typeof setup>>, settleRemote = true) {
  const records = new Map<string, VisionRecord>(), register = vi.fn(async (r: VisionRecord) => { records.set(r.input.operationId, r); });
  const registry: VisionRegistry = { read: async id => records.get(id) ?? null, register };
  return { records, register, registry, handoff: new VisionHandoff(new MemoryObjects(), f.remote, registry, "test/1", f.verify, { settleRemote }) };
}
describe("cloud mode: ledger-less vision worker, Mini registers on first read", () => {
  it("complete without a ledger retains completion locally and remotely and returns the record without registering", async () => {
    const f = await setup(); expect(f.outcome.status).toBe("candidate");
    const record = await f.cloud.complete(f.task, signal());
    expect(record.status).toBe("candidate"); expect(f.remote.data.has(record.completion.objectKey)).toBe(true);
    expect(f.local.data.has(`v3/vision/${f.task.input.operationId}/registration.json`)).toBe(true);
    expect(await f.cloud.inspect(f.task, signal())).toBeNull();
    await expect(f.cloud.registerFromRemote(f.task, signal())).rejects.toThrow("VISION.REGISTRY_UNAVAILABLE");
  });
  it("a Mini consumer with the ledger registers from remote evidence exactly once and reads the candidate", async () => {
    const f = await setup(), record = await f.cloud.complete(f.task, signal()), m = mini(f), writes = f.remote.writes;
    const read = await m.handoff.readCandidate(f.task, signal());
    expect(read.record).toEqual(record); expect(read.candidate.formulaComplete).toBe(true);
    expect(m.register).toHaveBeenCalledOnce(); expect(m.records.size).toBe(1); expect(f.remote.writes).toBe(writes);
    await m.handoff.readCandidate(f.task, signal()); expect(m.register).toHaveBeenCalledOnce();
    expect(f.provider.interpret).toHaveBeenCalledOnce();
  });
  it("without settleRemote a Mini read stays read-only and unregistered evidence is not a result", async () => {
    const f = await setup(); await f.cloud.complete(f.task, signal());
    const m = mini(f, false);
    await expect(m.handoff.readCandidate(f.task, signal())).rejects.toThrow("VISION.RESULT_NOT_REGISTERED");
    expect(m.register).not.toHaveBeenCalled();
  });
  it("a tampered or missing remote completion never registers", async () => {
    const f = await setup(), record = await f.cloud.complete(f.task, signal()), m = mini(f);
    const key = record.completion.objectKey, original = f.remote.data.get(key)!;
    f.remote.data.set(key, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(original).toString()), status: "partial" })));
    await expect(m.handoff.registerFromRemote(f.task, signal())).rejects.toThrow("VISION.RESULT_INTEGRITY");
    f.remote.data.delete(key);
    await expect(m.handoff.registerFromRemote(f.task, signal())).rejects.toThrow("VISION.RESULT_NOT_DURABLE");
    expect(m.register).not.toHaveBeenCalled();
    f.remote.data.set(key, original);
    expect((await m.handoff.registerFromRemote(f.task, signal())).status).toBe("candidate"); expect(m.register).toHaveBeenCalledOnce();
  });
});
describe("RemoteOcrEvidence: OCR text verified from remote evidence only", () => {
  async function ocrFixture() {
    const o = await ocrSetup(); o.output.text = "Supplement\nFacts";
    const cloud = new OcrResultHandoff("fixture-r2/1", o.local, o.remote, o.journal, null);
    await cloud.capture(o.input, o.output, signal()); await cloud.uploadMissing(o.input, signal());
    const intent = { schemaVersion: 1, input: o.input, nonce: randomUUID(), nodeId: "cloud-node", storageId: "fixture-r2/1", createdAt: new Date().toISOString() };
    o.remote.data.set(`ocr-intents/${o.input.operationId}.json`, Buffer.from(JSON.stringify(intent)));
    const selected = screenKeywords({ observation: observationIdentity(o.input), image: o.input.file, ocrOperationId: o.input.operationId, text: o.output.text });
    const evidence = new RemoteOcrEvidence(new ArtifactResolver(o.local, o.remote), cloud, o.remote);
    return { ...o, selected, evidence };
  }
  it("returns the OCR text for a matching selection without any ledger", async () => {
    const f = await ocrFixture();
    expect(f.selected.status).toBe("matched");
    expect(await f.evidence.verifiedText(f.selected, signal())).toBe(f.output.text);
    expect((f.registry as { writes?: number }).writes ?? 0).toBe(0);
  });
  it("rejects a foreign image, a missing intent and tampered remote bytes", async () => {
    const f = await ocrFixture();
    await expect(f.evidence.verifiedText({ ...f.selected, image: { ...f.selected.image, artifactId: "other" } }, signal())).rejects.toThrow("SCREEN.SOURCE_CONFLICT");
    const key = `ocr-intents/${f.input.operationId}.json`, intent = f.remote.data.get(key)!;
    f.remote.data.delete(key);
    await expect(f.evidence.verifiedText(f.selected, signal())).rejects.toThrow("SCREEN.UPSTREAM_UNVERIFIED");
    f.remote.data.set(key, intent);
    const resultKey = `operations/${f.input.operationId}/${f.input.inputFingerprint}/result.json`, original = f.remote.data.get(resultKey)!;
    f.remote.data.set(resultKey, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(original).toString()), text: "tampered" })));
    await expect(f.evidence.verifiedText(f.selected, signal())).rejects.toThrow();
  });
});
