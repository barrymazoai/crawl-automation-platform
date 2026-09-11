import { describe, it, expect } from "vitest";
import { TextCandidateSchema, TextInputSchema, textFingerprint, textIdentity, type TextOutput } from "@crawl-automation/v3-contracts";
import { TextModule } from "./module.js";
import { TextHandoff, hashText } from "./handoff.js";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { fixture, signal } from "./testing.fixture.js";
describe("extractive text module", () => {
    it("registers verified evidence, with no OCR dependency for page text; redelivery is read-only", async () => {
        const f = fixture(), first = await f.module.run(f.input, signal());
        expect(first.status).toBe("registered");
        expect(f.calls()).toBe(1);
        expect(f.ocrInspections()).toBe(0);
        expect(await f.handoff.inspect(f.input, signal())).toMatchObject({ computedLocal: true, artifactDurable: true, resultRegistered: true });
        const puts = f.remote.writes;
        expect(await f.module.run(f.input, signal())).toEqual(first);
        expect(f.calls()).toBe(1);
        expect(f.remote.writes).toBe(puts);
        const record = f.registry.data.get(f.input.operationId)!;
        const output = JSON.parse(Buffer.from(f.remote.data.get(record.result.objectKey)!).toString());
        expect(output.rawResponse).toBe(JSON.stringify(output.candidate));
        expect(JSON.stringify(first)).not.toContain("rawResponse");
    });
    it("a replacement node uses durable evidence with an empty output cache", async () => {
        const f = fixture();
        const first = await f.module.run(f.input, signal());
        const handoff = new TextHandoff(new MemoryObjects(), f.remote, f.registry, f.evidence, "fixture/1");
        expect(await new TextModule({ ...f.deps, handoff, nodeId: "replacement" }).run(f.input, signal())).toEqual(first);
        expect(f.calls()).toBe(1);
    });
    it("eight concurrent duplicate deliveries make exactly one provider call", async () => {
        const f = fixture();
        const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => new TextModule({ ...f.deps, nodeId: `node-${i}` }).run(f.input, signal())));
        expect(f.calls()).toBe(1);
        expect(outcomes.some(o => o.status === "registered")).toBe(true);
        expect(f.registry.data.size).toBe(1);
    });
    it("distinct products overlap and finish in reverse order without mixing evidence", async () => {
        const a = fixture("ALPHA"), b = fixture("BRAVO");
        let entered!: () => void, finish!: () => void;
        const started = new Promise<void>(r => { entered = r; }), release = new Promise<void>(r => { finish = r; });
        const original = a.provider.interpret;
        a.provider.interpret = async (request, s) => { entered(); await release; return original(request, s); };
        const pending = a.module.run(a.input, signal());
        await started;
        expect((await b.module.run(b.input, signal())).status).toBe("registered");
        expect(a.registry.data.size).toBe(0);
        finish();
        expect((await pending).status).toBe("registered");
        for (const f of [a, b]) {
            const record = f.registry.data.get(f.input.operationId)!;
            const output = JSON.parse(Buffer.from(f.remote.data.get(record.result.objectKey)!).toString());
            expect(output.candidate.ingredients.items[0].text).toBe(f.text);
            expect(record.input.observationId).toBe(f.input.observationId);
        }
    });
    it.each(["not json", "```json\n{}\n```", JSON.stringify({ formula: null, ingredients: null, extra: true })])("keeps malformed output in passive Review without a repair call: %s", async (raw) => {
        const f = fixture();
        let calls = 0;
        f.provider.interpret = async () => { calls++; return raw; };
        expect(await f.module.run(f.input, signal())).toMatchObject({ status: "review", code: "TEXT.MODEL_SCHEMA", automaticRetry: false });
        expect([...f.reviews.records.values()][0]!.candidate?.value).toEqual({ rawResponse: raw });
        await f.module.run(f.input, signal());
        expect(calls).toBe(1);
        expect(f.registry.data.size).toBe(0);
    });
    it("rejects a schema-valid hallucinated citation", async () => {
        const f = fixture();
        f.provider.interpret = async () => JSON.stringify({ formula: null, ingredients: { items: [{ text: "invented", start: 0, end: 8 }] } });
        expect(await f.module.run(f.input, signal())).toMatchObject({ code: "TEXT.CITATION_INVALID" });
        expect(f.registry.data.size).toBe(0);
    });
    it("does not mistake candidate absence for the downstream product eligibility decision", async () => {
        const f = fixture();
        f.provider.interpret = async () => JSON.stringify({ formula: null, ingredients: null });
        expect((await f.module.run(f.input, signal())).status).toBe("registered");
    });
    it("refuses conflicting input fingerprints before provider or intent writes", async () => {
        const f = fixture();
        await expect(f.module.run({ ...f.input, range: { start: 1, end: 5 } }, signal())).rejects.toThrow("TEXT.INVALID_INPUT");
        expect(f.calls()).toBe(0);
        expect(f.remote.writes).toBe(0);
        expect(TextInputSchema.safeParse({ ...f.input, listingId: "other" }).success).toBe(false);
        expect(TextInputSchema.safeParse({ ...f.input, operationId: f.ref.producer.operationId }).success).toBe(false);
    });
    it("validates document brand identity before claiming an invocation", async () => {
        const f = fixture();
        const input = { ...f.input, brandId: "other" };
        input.inputFingerprint = textFingerprint(input, hashText);
        expect(await f.module.run(input, signal())).toMatchObject({ code: "TEXT.SOURCE_CONFLICT" });
        expect(f.calls()).toBe(0);
        expect(f.remote.writes).toBe(0);
    });
    it("missing source evidence cannot call the provider", async () => {
        const f = fixture();
        f.remote.data.delete(f.source.objectKey);
        expect(await f.module.run(f.input, signal())).toMatchObject({ code: "TEXT.EVIDENCE_UNAVAILABLE" });
        expect(f.calls()).toBe(0);
    });
    it("uncertain intent acknowledgement is never interpreted as permission to call", async () => {
        const f = fixture();
        f.remote.unknown = true;
        expect(await f.module.run(f.input, signal())).toMatchObject({ code: "TEXT.INTENT_UNKNOWN" });
        f.remote.unknown = false;
        await f.module.run(f.input, signal());
        expect(f.calls()).toBe(0);
    });
    it("provider failure remains unknown and a duplicate never calls again", async () => {
        const f = fixture();
        let calls = 0;
        f.provider.interpret = async () => { calls++; throw Error("timeout"); };
        expect((await f.module.run(f.input, signal())).status).toBe("review");
        expect([...f.reviews.records.values()][0]!.failure.executionFact).toBe("unknown");
        await f.module.run(f.input, signal());
        expect(calls).toBe(1);
    });
    it("lost result registration acknowledgement recovers through readback", async () => {
        const f = fixture();
        f.registry.lost = true;
        expect((await f.module.run(f.input, signal())).status).toBe("registered");
        expect(f.calls()).toBe(1);
    });
    it("failed registration preserves completed evidence; explicit handoff recovery never reruns a model", async () => {
        const f = fixture();
        f.registry.unavailable = true;
        expect((await f.module.run(f.input, signal())).status).toBe("review");
        expect(await f.handoff.inspect(f.input, signal())).toMatchObject({ computedLocal: true, artifactDurable: true, resultRegistered: false });
        f.registry.unavailable = false;
        expect(await f.module.run(f.input, signal())).toMatchObject({ code: "TEXT.HANDOFF_INCOMPLETE" });
        await f.handoff.register(f.input, signal());
        expect((await f.module.run(f.input, signal())).status).toBe("registered");
        expect(f.calls()).toBe(1);
    });
    it("late provider response after cancellation is saved locally, with no onward write", async () => {
        const f = fixture(), controller = new AbortController(), original = f.provider.interpret;
        f.provider.interpret = async (r, s) => { const response = await original(r, s); controller.abort(); return response; };
        expect(await f.module.run(f.input, controller.signal)).toMatchObject({ code: "TEXT.CANCELLED" });
        expect(await f.handoff.inspect(f.input, signal())).toMatchObject({ computedLocal: true, artifactDurable: false, resultRegistered: false });
        expect(f.calls()).toBe(1);
    });
    it("lost Review acknowledgement is verified, not appended twice", async () => {
        const f = fixture();
        f.reviews.lost = true;
        f.provider.interpret = async () => "invalid";
        expect((await f.module.run(f.input, signal())).status).toBe("review");
        expect(f.reviews.records.size).toBe(1);
    });
    it("refuses capture of another operation's otherwise valid candidate", async () => {
        const f = fixture(), candidate = TextCandidateSchema.parse({ formula: null, ingredients: null });
        const output: TextOutput = { ...textIdentity(f.input), operationId: "other-op", provider: "fixture/1", candidate, rawResponse: JSON.stringify(candidate) };
        await expect(f.handoff.capture(f.input, output, signal())).rejects.toThrow("TEXT.RESULT_INTEGRITY");
        expect(f.local.writes).toBe(0);
    });
    it("a corrupt durable result is not accepted or recomputed", async () => {
        const f = fixture();
        await f.module.run(f.input, signal());
        const result = f.registry.data.get(f.input.operationId)!.result;
        f.remote.data.set(result.objectKey, Buffer.from("tampered"));
        expect((await f.module.run(f.input, signal())).status).toBe("review");
        expect(f.calls()).toBe(1);
    });
});
