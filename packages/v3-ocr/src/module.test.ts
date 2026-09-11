import { expect, it } from "vitest";
import { OcrFileModule } from "./module.js";
import { OcrError } from "./ports.js";
import { OcrIntents } from "./intent.js";
import { setup, signal } from "./testing.fixture.js";
import { fingerprintOcrInput } from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/v3-artifacts";

it("single image -> retained raw text, durable files and registered small receipt", async () => {
  const s = await setup(); const result = await s.module.run(s.input, signal());
  expect(result.status).toBe("registered"); expect(s.calls()).toBe(1);
  expect(await s.results.inspect(s.input, signal())).toMatchObject({ computedLocal: true, artifactDurable: true, resultRegistered: true });
  const record = await s.registry.read(s.input.operationId);
  const bytes = s.remote.data.get(record!.result.objectKey)!;
  expect(JSON.parse(Buffer.from(bytes).toString()).text).toBe("  Synthetic recognized text\nIngredients: test only.  ");
  expect(JSON.stringify(result)).not.toContain("Synthetic recognized");
});
it("completed repeated delivery never calls OCR again", async () => {
  const s = await setup(); const first = await s.module.run(s.input, signal());
  expect(await s.module.run(s.input, signal())).toEqual(first); expect(s.calls()).toBe(1);
});
it("eight concurrent deliveries across two module instances admit at most one call", async () => {
  const s = await setup(); const other = new OcrFileModule({ ...s.deps, intents: new OcrIntents(s.remote, "another-node", "fixture/1") });
  const results = await Promise.all(Array.from({ length: 8 }, (_, n) => (n % 2 ? other : s.module).run(s.input, signal())));
  expect(s.calls()).toBe(1); expect(results.some(r => r.status === "registered")).toBe(true);
});
it("lost claim acknowledgement grants no request permission and never expires", async () => {
  const s = await setup(); s.remote.unknown = true;
  expect(await s.module.run(s.input, signal())).toMatchObject({ status: "review", code: "OCR.INTENT_UNKNOWN" });
  s.remote.unknown = false;
  expect(await s.module.run(s.input, signal())).toMatchObject({ status: "review", code: "OCR.EXECUTION_UNKNOWN" });
  expect(s.calls()).toBe(0);
});
it("timeout stays unknown, performs read-only verification and does not retry", async () => {
  const s = await setup(); let calls = 0;
  s.provider.recognize = async () => { calls++; throw new OcrError("OCR.TIMEOUT"); };
  expect(await s.module.run(s.input, signal())).toMatchObject({ status: "review", code: "OCR.TIMEOUT" });
  expect([...s.reviews.records.values()][0]?.failure.executionFact).toBe("unknown");
  await s.module.run(s.input, signal()); expect(calls).toBe(1);
});
it("lost result registration response is recovered without another provider call/INSERT", async () => {
  const s = await setup(); s.registry.loseAfterCommit = true;
  expect(await s.module.run(s.input, signal())).toMatchObject({ status: "registered" });
  expect(s.registry.writes).toBe(1); expect(s.calls()).toBe(1); expect(s.reviews.records.size).toBe(0);
});
it("local completion with missing handoff does not reprocess or auto-repair on redelivery", async () => {
  const s = await setup(); const original = s.deps.results.uploadMissing;
  s.deps.results.uploadMissing = async () => { throw new OcrError("OCR.HANDOFF_INCOMPLETE", "executed"); };
  expect(await s.module.run(s.input, signal())).toMatchObject({ status: "review" });
  s.deps.results.uploadMissing = original;
  const writes = s.remote.writes;
  expect(await s.module.run(s.input, signal())).toMatchObject({ status: "review", code: "OCR.HANDOFF_INCOMPLETE" });
  expect(s.calls()).toBe(1); expect(s.remote.writes).toBe(writes);
});
it("late cancellation retains provider output before reporting Review", async () => {
  const s = await setup(), controller = new AbortController();
  s.provider.recognize = async () => { controller.abort(); return { text: "received before cancellation", lines: [] }; };
  expect(await s.module.run(s.input, controller.signal)).toMatchObject({ status: "review", code: "OCR.CANCELLED" });
  expect(await s.results.inspect(s.input, signal())).toMatchObject({ computedLocal: true, resultRegistered: false });
});
it("lost Review acknowledgement is verified, not appended twice", async () => {
  const s = await setup(); s.reviews.lost = true;
  s.provider.recognize = async () => { throw new OcrError("OCR.TIMEOUT"); };
  expect(await s.module.run(s.input, signal())).toMatchObject({ status: "review" });
  expect(s.reviews.records.size).toBe(1);
});
it("unavailable Review cannot be reported as persisted", async () => {
  const s = await setup(); s.reviews.unavailable = true;
  s.provider.recognize = async () => { throw new OcrError("OCR.TIMEOUT"); };
  await expect(s.module.run(s.input, signal())).rejects.toThrow();
  expect(await s.deps.intents.read(s.input, signal())).not.toBeNull();
});
it("bad identity/version input does not touch provider or intents", async () => {
  const s = await setup();
  await expect(s.module.run({ ...s.input, files: [s.input.file] }, signal())).rejects.toMatchObject({ code: "OCR.INVALID_INPUT" });
  expect(s.calls()).toBe(0); expect(s.remote.writes).toBe(0);
});
it("existing intent with different semantic input conflicts", async () => {
  const s = await setup(); await s.deps.intents.acquire(s.input, signal());
  const changed = { ...s.input, requestId: "changed-request" };
  changed.inputFingerprint = fingerprintOcrInput(changed, x => sha256(Buffer.from(x)));
  expect(await s.module.run(changed, signal())).toMatchObject({ status: "review", code: "OCR.INTENT_CONFLICT" });
  expect(s.calls()).toBe(0);
});
it("missing source creates passive error before acquiring execution intent", async () => {
  const s = await setup(); s.deps.artifacts = { resolve: async () => { throw new OcrError("ARTIFACT.MISSING", "not_executed"); } };
  const result = await new OcrFileModule(s.deps).run(s.input, signal());
  expect(result).toMatchObject({ status: "review", code: "ARTIFACT.MISSING" });
  expect(s.calls()).toBe(0); expect(s.remote.writes).toBe(0);
});
it("oversized provider output is classified without overflowing the Review payload", async () => {
  const s = await setup(); s.provider.recognize = async () => ({ text: "x".repeat(1500000), lines: [] });
  expect(await s.module.run(s.input, signal())).toMatchObject({ status: "review", code: "OCR.OUTPUT_LIMIT" });
  expect([...s.reviews.records.values()][0]?.candidate).toBeNull();
  expect(await s.deps.intents.read(s.input, signal())).not.toBeNull();
});
it("explicit handoff repair later permits read-only success without OCR", async () => {
  const s = await setup(), upload = s.results.uploadMissing.bind(s.results);
  s.results.uploadMissing = async () => { throw new OcrError("OCR.HANDOFF_INCOMPLETE", "executed"); };
  await s.module.run(s.input, signal());
  s.results.uploadMissing = upload;
  await s.results.uploadMissing(s.input, signal()); await s.results.register(s.input, signal());
  expect(await s.module.run(s.input, signal())).toMatchObject({ status: "registered" }); expect(s.calls()).toBe(1);
});
it("rendered PDF page retains its parent/page provenance through OCR registration", async () => {
  const s = await setup();
  s.input.file = { ...s.input.file, kind: "pdf-page", mediaType: "image/png", parentArtifactId: "parent-pdf", pageIndex: 3 };
  s.input.inputFingerprint = fingerprintOcrInput(s.input, x => sha256(Buffer.from(x)));
  // Same bytes, but a distinct validated reference needs its own local metadata.
  s.remote.data.set(s.input.file.objectKey, (await import("./testing.fixture.js")).png);
  expect(await s.module.run(s.input, signal())).toMatchObject({ status: "registered" });
  expect((await s.registry.read(s.input.operationId))?.input.file).toMatchObject({ kind: "pdf-page", parentArtifactId: "parent-pdf", pageIndex: 3 });
});
