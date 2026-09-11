import { expect, it } from "vitest";
import { ArtifactResolver } from "@crawl-automation/v3-artifacts";
import { PreparedTextWorkflowInputSchema, TextReceiptOutcomeSchema } from "@crawl-automation/v3-contracts";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { fixture, signal } from "./testing.fixture.js";
import { TextEvidence } from "./evidence.js";
import { TextHandoff } from "./handoff.js";
import { ResolveTextReceipt } from "./receipt.js";

const resolver = (f: ReturnType<typeof fixture>) => new ResolveTextReceipt({ results: f.handoff, reviews: f.reviews, local: f.local });
it("lost receipt and empty replacement cache only inspect durable registered evidence", async () => {
  const f = fixture(), outcome = await f.module.run(f.input, signal()), writes = f.remote.writes;
  const local = new MemoryObjects(), evidence = new TextEvidence(new ArtifactResolver({ read: async () => null, retain: async () => {} }, f.remote),
    { inspect: async () => { throw Error("prepared text must not wait for OCR"); } });
  const handoff = new TextHandoff(local, f.remote, f.registry, evidence, "fixture/1");
  const r = new ResolveTextReceipt({ results: { inspect: (input, s) => handoff.inspect(input, s) }, reviews: f.reviews, local });
  const first = await r.run({ input: f.input, outcome }, signal());
  expect(first).toMatchObject({ status: "registered", registration: { input: f.input } });
  expect(await r.run({ input: f.input, outcome: null }, signal())).toEqual(first);
  expect(TextReceiptOutcomeSchema.safeParse(first).success).toBe(true);
  expect(f.calls()).toBe(1); expect(f.remote.writes).toBe(writes); expect(local.data.size).toBe(0);
});
it("missing result is Review, not an invitation to execute or register", async () => {
  const f = fixture();
  expect(await resolver(f).run({ input: f.input, outcome: null }, signal())).toMatchObject({ status: "review", code: "TEXT_RECEIPT.TEXT_UNCONFIRMED" });
  expect(f.calls()).toBe(0); expect(f.registry.data.size).toBe(0); expect(f.remote.writes).toBe(0);
});
it("local/durable but unregistered output remains unconfirmed without registration or upload", async () => {
  const f = fixture(); await f.module.run(f.input, signal()); f.registry.data.clear();
  const writes = f.remote.writes;
  expect(await resolver(f).run({ input: f.input, outcome: null }, signal())).toMatchObject({ status: "review", code: "TEXT_RECEIPT.TEXT_UNCONFIRMED" });
  expect(f.registry.data.size).toBe(0); expect(f.calls()).toBe(1); expect(f.remote.writes).toBe(writes);
});
it("tampered source and output cannot produce a verified success", async () => {
  for (const target of ["source", "result"] as const) {
    const f = fixture(), outcome = await f.module.run(f.input, signal());
    if (outcome.status !== "registered") throw Error();
    f.remote.data.set(target === "source" ? f.source.objectKey : outcome.result.objectKey, Buffer.from("tampered"));
    expect(await resolver(f).run({ input: f.input, outcome }, signal())).toMatchObject({ status: "review", code: "TEXT_RECEIPT.EVIDENCE_UNVERIFIED" });
    expect(f.calls()).toBe(1);
  }
});
it("foreign operation or modified artifact receipt is rejected", async () => {
  const f = fixture(), outcome = await f.module.run(f.input, signal());
  if (outcome.status !== "registered") throw Error();
  for (const forged of [{ ...outcome, operationId: "foreign" }, { ...outcome, result: { ...outcome.result, sha256: "b".repeat(64) } }])
    expect(await resolver(f).run({ input: f.input, outcome: forged }, signal())).toMatchObject({ status: "review", code: "TEXT_RECEIPT.IDENTITY_CONFLICT" });
  expect(f.calls()).toBe(1);
});
it("explicit upstream Review is checked and retained, never promoted or re-executed", async () => {
  const f = fixture(); f.provider.interpret = async () => { throw Error("synthetic failure"); };
  const outcome = await f.module.run(f.input, signal());
  if (outcome.status !== "review") throw Error();
  const r = new ResolveTextReceipt({ results: { inspect: async () => { throw Error("must not inspect after explicit Review"); } }, local: f.local, reviews: f.reviews });
  expect(await r.run({ input: f.input, outcome }, signal())).toEqual(outcome);
  expect(f.reviews.records.size).toBe(1);
  expect(await r.run({ input: f.input, outcome: { ...outcome, code: "TEXT.FORGED" } }, signal())).toMatchObject({ code: "TEXT_RECEIPT.IDENTITY_CONFLICT" });
  expect(await r.run({ input: f.input, outcome: { ...outcome, reviewId: "missing" } }, signal())).toMatchObject({ code: "TEXT_RECEIPT.REVIEW_UNVERIFIED" });
});
it("Review acknowledgment loss is read back, failed persistence is not reported as success", async () => {
  const f = fixture(); f.reviews.lost = true;
  expect(await resolver(f).run({ input: f.input, outcome: null }, signal())).toMatchObject({ status: "review" });
  expect(f.reviews.records.size).toBe(1);
  const unavailable = new ResolveTextReceipt({ results: f.handoff, local: f.local, reviews: {
    read: async () => null, append: async () => { throw Error("private connection details"); } } });
  await expect(unavailable.run({ input: f.input, outcome: null }, signal())).rejects.toThrow("TEXT_RECEIPT.REVIEW_UNVERIFIED");
  expect(f.local.data.size).toBe(2);
});
it("bad fingerprint fails before model/evidence access and prepared workflow rejects legacy inputs", async () => {
  const f = fixture();
  await expect(resolver(f).run({ input: { ...f.input, inputFingerprint: "b".repeat(64) }, outcome: null }, signal())).rejects.toThrow("TEXT.INPUT_CONFLICT");
  expect(f.reviews.records.size).toBe(0); expect(f.calls()).toBe(0);
  const queues = { text: "text", receipts: "receipt" };
  expect(PreparedTextWorkflowInputSchema.safeParse({ task: f.input, queues }).success).toBe(false);
  expect(PreparedTextWorkflowInputSchema.safeParse({ task: { ...f.input, resultSchemaVersion: 2 }, queues }).success).toBe(true);
});
