import { describe, expect, it } from "vitest";
import { ArtifactResolver } from "@crawl-automation/v3-artifacts";
import { TextInputSchema, textFingerprint, observationIdentity } from "@crawl-automation/v3-contracts";
import { RemoteReviews } from "@crawl-automation/v3-review";
import { OcrResultHandoff } from "@crawl-automation/v3-results";
import { MemoryObjects, setup as ocrSetup } from "../../v3-results/src/testing.fixture.js";
import { TextEvidence } from "./evidence.js";
import { TextHandoff, hashText } from "./handoff.js";
import { TextModule } from "./module.js";
import { ResolveTextReceipt } from "./receipt.js";
import { MemoryTextRegistry, MemoryTextReviews, fixture, signal } from "./testing.fixture.js";

const cache = { read: async () => null, retain: async () => {} };
function cloud(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const local = new MemoryObjects(), handoff = new TextHandoff(local, f.remote, null, f.evidence, "fixture/1");
  return { local, handoff, module: new TextModule({ ...f.deps, handoff, mode: "upload-only", ...overrides } as ConstructorParameters<typeof TextModule>[0]) };
}
function mini(f: ReturnType<typeof fixture>) {
  const local = new MemoryObjects(), registry = new MemoryTextRegistry();
  const evidence = new TextEvidence(new ArtifactResolver(cache, f.remote), { inspect: async () => { throw Error("prepared text must not inspect OCR"); } });
  const handoff = new TextHandoff(local, f.remote, registry, evidence, "fixture/1");
  return { local, registry, handoff, resolver: new ResolveTextReceipt({ results: handoff, reviews: f.reviews, local: new MemoryObjects(), remoteReviews: new RemoteReviews(f.remote) }) };
}
describe("cloud mode: ledger-less text worker, Mini registers from remote bytes", () => {
  it("upload-only returns uploaded, retains result/completion remotely, never registers, and is idempotent", async () => {
    const f = fixture(), c = cloud(f), first = await c.module.run(f.input, signal());
    expect(first.status).toBe("uploaded"); if (first.status !== "uploaded") throw Error("unreachable");
    expect(f.remote.data.has(first.result.objectKey)).toBe(true); expect(f.remote.data.has(first.completion.objectKey)).toBe(true);
    expect(f.registry.data.size).toBe(0); expect(f.calls()).toBe(1);
    await expect(c.handoff.register(f.input, signal())).rejects.toMatchObject({ code: "TEXT.REGISTRY_UNAVAILABLE" });
    const writes = f.remote.writes;
    expect(await c.module.run(f.input, signal())).toEqual(first); expect(f.calls()).toBe(1); expect(f.remote.writes).toBe(writes);
  });
  it("Mini rebuilds the identical record from remote bytes, registers once, and the receipt answers registered", async () => {
    const f = fixture(), c = cloud(f), outcome = await c.module.run(f.input, signal()), m = mini(f), writes = f.remote.writes;
    const facts = await m.handoff.registerFromRemote(f.input, signal());
    expect(facts).toMatchObject({ computedLocal: true, artifactDurable: true, resultRegistered: true });
    if (outcome.status !== "uploaded") throw Error("unreachable");
    expect(facts.record?.result).toEqual(outcome.result); expect(facts.record?.completion).toEqual(outcome.completion);
    expect(m.registry.data.size).toBe(1); expect(f.remote.writes).toBe(writes);
    expect(await m.handoff.registerFromRemote(f.input, signal())).toMatchObject({ resultRegistered: true }); expect(m.registry.data.size).toBe(1);
    const r = await m.resolver.run({ input: f.input, outcome }, signal());
    expect(r).toMatchObject({ status: "registered", registration: { input: f.input, result: outcome.result } });
    expect(f.calls()).toBe(1); expect(f.remote.writes).toBe(writes);
  });
  it("the receipt registers an uploaded outcome itself and rejects forged refs or tampered bytes", async () => {
    const f = fixture(), c = cloud(f), outcome = await c.module.run(f.input, signal());
    if (outcome.status !== "uploaded") throw Error("unreachable");
    const original = f.remote.data.get(outcome.result.objectKey)!;
    f.remote.data.set(outcome.result.objectKey, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(original).toString()), rawResponse: "{}" })));
    const tampered = mini(f);
    await expect(tampered.handoff.registerFromRemote(f.input, signal())).rejects.toMatchObject({ code: "TEXT.RESULT_INTEGRITY" });
    expect(tampered.registry.data.size).toBe(0);
    f.remote.data.set(outcome.result.objectKey, original);
    const m = mini(f);
    const forged = await m.resolver.run({ input: f.input, outcome: { ...outcome, result: { ...outcome.result, sha256: "b".repeat(64) } } }, signal());
    expect(forged).toMatchObject({ status: "review", code: "TEXT_RECEIPT.IDENTITY_CONFLICT" });
    expect(await m.resolver.run({ input: f.input, outcome }, signal())).toMatchObject({ status: "registered" });
    expect(m.registry.data.size).toBe(1);
  });
  it("a cloud-mode Review retained remotely enters the ledger through the receipt with identity checks", async () => {
    const f = fixture(), remoteReviews = new RemoteReviews(f.remote);
    const provider = { ...f.provider, interpret: async () => { throw Object.assign(Error("TEXT.OUTPUT_LIMIT"), { code: "TEXT.OUTPUT_LIMIT", executionFact: "executed" }); } };
    const c = cloud(f, { provider, reviews: remoteReviews }), outcome = await c.module.run(f.input, signal());
    expect(outcome.status).toBe("review"); if (outcome.status !== "review") throw Error("unreachable");
    expect(f.reviews.records.has(outcome.reviewId)).toBe(false); expect(f.registry.data.size).toBe(0);
    const m = mini(f), r = await m.resolver.run({ input: f.input, outcome }, signal());
    expect(r).toMatchObject({ status: "review", reviewId: outcome.reviewId, code: outcome.code });
    expect(f.reviews.records.has(outcome.reviewId)).toBe(true);
    const wrong = await m.resolver.run({ input: f.input, outcome: { ...outcome, code: "TEXT.OUTPUT_LIMIT" } }, signal());
    expect(wrong).toMatchObject({ status: "review", code: "TEXT_RECEIPT.IDENTITY_CONFLICT" });
  });
  it("OCR-sourced text on a ledger-less worker verifies the embedded registration against remote OCR bytes", async () => {
    const o = await ocrSetup(); o.output.text = "Vitamin C 10 mg\nIngredients: water";
    const ocrCloud = new OcrResultHandoff("fixture-r2/1", o.local, o.remote, o.journal, null);
    const record = await ocrCloud.capture(o.input, o.output, signal()); await ocrCloud.uploadMissing(o.input, signal());
    const owner = observationIdentity(o.input), supported = { schemaVersion: 1 as const, module: "codex.text" as const, implementationVersion: "text/1", policyVersion: "extractive/1", resultSchemaVersion: 1 as const, configFingerprint: "a".repeat(64) };
    const unsigned = { ...owner, ...supported, operationId: `text-${o.input.operationId}`, source: { kind: "ocr" as const, registration: record }, range: { start: 0, end: o.output.text.length } };
    const input = TextInputSchema.parse({ ...unsigned, inputFingerprint: textFingerprint(unsigned, hashText) });
    const fresh = new OcrResultHandoff("fixture-r2/1", new MemoryObjects() as never, o.remote, { read: async () => null, create: async () => {} }, null);
    await expect(new TextEvidence(new ArtifactResolver(cache, o.remote), fresh).resolve(input, signal())).rejects.toMatchObject({ code: "TEXT.UPSTREAM_UNVERIFIED" });
    const resolved = await new TextEvidence(new ArtifactResolver(cache, o.remote), fresh, fresh).resolve(input, signal());
    expect(resolved.text).toBe(o.output.text); expect(resolved.refs.map(r => r.objectKey)).toContain(record.result.objectKey);
    const other = { ...input, source: { kind: "ocr" as const, registration: { ...record, storageId: "other/1" } } };
    await expect(new TextEvidence(new ArtifactResolver(cache, o.remote), fresh, fresh).resolve(other, signal())).rejects.toMatchObject({ code: "TEXT.UPSTREAM_UNVERIFIED" });
  });
});
