import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { fingerprintOcrInput } from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { digest, prepare } from "./codec.js";
import { OcrResultHandoff } from "./handoff.js";
import { MemoryRegistry, setup, signal } from "./testing.fixture.js";
describe("evidence-driven result handoff, no provider port", () => {
    it("oversized declared source is rejected before storage I/O", async () => {
        const s = await setup();
        const input = {...s.input, file: {...s.input.file, byteSize: 33 * 1024 * 1024}};
        input.inputFingerprint = fingerprintOcrInput(input, digest);
        await expect(s.handoff.capture(input, {...s.output, inputFingerprint: input.inputFingerprint}, signal())).rejects.toMatchObject({code:"RESULT.INTEGRITY"});
        expect(await s.journal.read(input.operationId)).toBeNull();
        expect(s.remote.reads).toBe(0);
    });
    it("cancellation during a database read cannot return a success snapshot", async () => {
        const controller = new AbortController();
        const s = await setup({read:async()=>{controller.abort();return null;},register:async()=>{throw Error("No writes");}});
        await expect(s.handoff.inspect(s.input,controller.signal)).rejects.toThrow();
        expect(s.remote.writes).toBe(0);
    });
    it("original image alone cannot claim completion", async () => {
        const s = await setup();
        expect(await s.handoff.inspect(s.input, signal())).toMatchObject({ computedLocal: false, artifactDurable: false, resultRegistered: false, record: null });
        await expect(s.handoff.uploadMissing(s.input, signal())).rejects.toMatchObject({ code: "RESULT.INCOMPLETE" });
        expect(s.remote.writes).toBe(0);
    });
    it("computed, durable and registered facts advance independently", async () => {
        const registry = new MemoryRegistry(), s = await setup(registry);
        await s.handoff.capture(s.input, s.output, signal());
        expect(await s.handoff.inspect(s.input, signal())).toMatchObject({ computedLocal: true, artifactDurable: false, resultRegistered: false });
        await expect(s.handoff.register(s.input, signal())).rejects.toMatchObject({ code: "RESULT.NOT_DURABLE" });
        expect(await s.handoff.uploadMissing(s.input, signal())).toMatchObject({ computedLocal: true, artifactDurable: true, resultRegistered: false });
        expect(await s.handoff.register(s.input, signal())).toMatchObject({ computedLocal: true, artifactDurable: true, resultRegistered: true });
        expect(s.remote.writes).toBe(2);
        expect(registry.writes).toBe(1);
        await s.handoff.uploadMissing(s.input, signal());
        await s.handoff.register(s.input, signal());
        expect(s.remote.writes).toBe(2);
        expect(registry.writes).toBe(1);
    });
    it("inspection never writes or populates local cache", async () => {
        const registry = new MemoryRegistry(), s = await setup(registry);
        await s.handoff.capture(s.input, s.output, signal());
        const before = await readFile(join(s.root, "journal", `${s.input.operationId}.json`));
        await s.handoff.inspect(s.input, signal());
        await s.handoff.inspect(s.input, signal());
        expect(s.remote.writes).toBe(0);
        expect(registry.writes).toBe(0);
        expect(await readFile(join(s.root, "journal", `${s.input.operationId}.json`))).toEqual(before);
    });
    it("register response lost after commit is resolved only by a read", async () => {
        const registry = new MemoryRegistry(), s = await setup(registry);
        await s.handoff.capture(s.input, s.output, signal());
        await s.handoff.uploadMissing(s.input, signal());
        registry.loseAfterCommit = true;
        await expect(s.handoff.register(s.input, signal())).rejects.toMatchObject({ code: "RESULT.REGISTRATION_UNKNOWN" });
        expect(await s.handoff.inspect(s.input, signal())).toMatchObject({ resultRegistered: true });
        expect(registry.writes).toBe(1);
        await s.handoff.register(s.input, signal());
        expect(registry.writes).toBe(1);
    });
    it("unknown upload that actually succeeded is reconciled, not resent", async () => {
        const s = await setup();
        await s.handoff.capture(s.input, s.output, signal());
        s.remote.unknown = true;
        expect(await s.handoff.uploadMissing(s.input, signal())).toMatchObject({ artifactDurable: true });
        expect(s.remote.writes).toBe(2);
    });
    it("half local output and a complete-looking journal cannot authorize upload", async () => {
        const s = await setup();
        const p = prepare(s.input, s.output, "fixture-r2/1");
        await s.local.retain(p.record.result, p.resultBytes, signal());
        await s.journal.create(p.record);
        expect(await s.handoff.inspect(s.input, signal())).toMatchObject({ computedLocal: false, artifactDurable: false });
        await expect(s.handoff.uploadMissing(s.input, signal())).rejects.toMatchObject({ code: "RESULT.INCOMPLETE" });
        expect(s.remote.writes).toBe(0);
    });
    it.each(["implementationVersion", "policyVersion", "configFingerprint"] as const)("changed %s is rejected even with a recomputed fingerprint", async (field) => {
        const s = await setup();
        await s.handoff.capture(s.input, s.output, signal());
        const changed = { ...s.input, [field]: field === "configFingerprint" ? "b".repeat(64) : "changed/2" };
        changed.inputFingerprint = fingerprintOcrInput(changed, digest);
        await expect(s.handoff.inspect(changed, signal())).rejects.toMatchObject({ code: "RESULT.CONFLICT" });
        expect(s.remote.writes).toBe(0);
    });
    it("same operation with different result does not overwrite the journal", async () => {
        const s = await setup();
        const original = await s.handoff.capture(s.input, s.output, signal());
        await expect(s.handoff.capture(s.input, { ...s.output, text: "different" }, signal())).rejects.toMatchObject({ code: "RESULT.CONFLICT" });
        expect(await s.journal.read(s.input.operationId)).toEqual(original);
    });
    it("valid JSON and matching byte hashes cannot hide a wrong completion result hash", async () => {
        const s = await setup(), p = prepare(s.input, s.output, "fixture-r2/1");
        const bad = Buffer.from(JSON.stringify({ ...JSON.parse(p.completionBytes.toString()), resultSha256: "0".repeat(64) }));
        const record = { ...p.record, completion: { ...p.record.completion, sha256: sha256(bad), byteSize: bad.length } };
        await s.journal.create(record);
        s.remote.data.set(record.result.objectKey, p.resultBytes);
        s.remote.data.set(record.completion.objectKey, bad);
        await expect(s.handoff.inspect(s.input, signal())).rejects.toMatchObject({ code: "RESULT.INTEGRITY" });
    });
    it("truncated journal is not missing and cannot restart computation", async () => {
        const s = await setup();
        await writeFile(join(s.root, "journal", `${s.input.operationId}.json`), "{partial");
        await expect(s.handoff.inspect(s.input, signal())).rejects.toMatchObject({ code: "RESULT.INTEGRITY" });
        expect(s.remote.writes).toBe(0);
    });
    it("registered row with missing remote evidence is not usable success", async () => {
        const s = await setup();
        const record = await s.handoff.capture(s.input, s.output, signal());
        await s.handoff.uploadMissing(s.input, signal());
        await s.handoff.register(s.input, signal());
        s.remote.data.delete(record.result.objectKey);
        await expect(s.handoff.inspect(s.input, signal())).rejects.toMatchObject({ code: "RESULT.NOT_DURABLE" });
        expect(s.remote.writes).toBe(2);
    });
    it("a registry record can recover after all local completion cache is unavailable", async () => {
        const s = await setup();
        await s.handoff.capture(s.input, s.output, signal());
        await s.handoff.uploadMissing(s.input, signal());
        await s.handoff.register(s.input, signal());
        const h = new OcrResultHandoff("fixture-r2/1", { read: async () => null, retain: async () => { throw Error("No writes"); } }, s.remote, { read: async () => null, create: async () => { throw Error("No writes"); } }, s.registry);
        expect(await h.inspect(s.input, signal())).toMatchObject({ computedLocal: false, artifactDurable: true, resultRegistered: true });
    });
    it("remote unavailable is unknown, not absence or permission to repair", async () => {
        const s = await setup();
        await s.handoff.capture(s.input, s.output, signal());
        s.remote.unavailable = true;
        await expect(s.handoff.uploadMissing(s.input, signal())).rejects.toThrow();
        expect(s.remote.writes).toBe(0);
    });
    it("failure before a registration commit requires read-only inspection then explicit retry", async () => {
        const registry = new MemoryRegistry();
        let unavailable = true, attempts = 0;
        const s = await setup({ read: (id) => registry.read(id), register: async (record) => { attempts++; if (unavailable)
                throw Error("connection lost"); await registry.register(record); } });
        await s.handoff.capture(s.input, s.output, signal());
        await s.handoff.uploadMissing(s.input, signal());
        await expect(s.handoff.register(s.input, signal())).rejects.toMatchObject({ code: "RESULT.REGISTRATION_UNKNOWN" });
        expect(await s.handoff.inspect(s.input, signal())).toMatchObject({ artifactDurable: true, resultRegistered: false });
        expect(attempts).toBe(1);
        unavailable = false;
        expect(await s.handoff.register(s.input, signal())).toMatchObject({ resultRegistered: true });
        expect(attempts).toBe(2);
        expect(s.remote.writes).toBe(2);
    });
    it("partial remote handoff resumes only missing artifacts after an unavailable readback", async () => {
        const s = await setup();
        await s.handoff.capture(s.input, s.output, signal());
        const create = s.remote.create.bind(s.remote);
        let inject = true;
        s.remote.create = async (key, bytes) => { const result = await create(key, bytes); if (inject)
            s.remote.unavailable = true; return result; };
        await expect(s.handoff.uploadMissing(s.input, signal())).rejects.toMatchObject({ code: "ARTIFACT.UPLOAD_UNKNOWN" });
        expect(s.remote.writes).toBe(1);
        inject = false;
        s.remote.unavailable = false;
        expect(await s.handoff.inspect(s.input, signal())).toMatchObject({ computedLocal: true, artifactDurable: false });
        expect(s.remote.writes).toBe(1);
        expect(await s.handoff.uploadMissing(s.input, signal())).toMatchObject({ artifactDurable: true });
        expect(s.remote.writes).toBe(2);
    });
    it("mismatched provider output cannot create a local completion", async () => {
        const s = await setup();
        await expect(s.handoff.capture(s.input, { ...s.output, operationId: "another-operation" }, signal())).rejects.toThrow("INPUT.CONFLICT");
        expect(await s.journal.read(s.input.operationId)).toBeNull();
        expect(s.remote.writes).toBe(0);
    });
    it("storage identity cannot silently relocate a completed operation", async () => {
        const s = await setup();
        await s.handoff.capture(s.input, s.output, signal());
        await expect(new OcrResultHandoff("different-r2/1", s.local, s.remote, s.journal, s.registry).inspect(s.input, signal())).rejects.toMatchObject({ code: "RESULT.CONFLICT" });
    });
});
