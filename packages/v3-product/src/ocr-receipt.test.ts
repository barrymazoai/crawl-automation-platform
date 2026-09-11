import { expect, it, vi } from "vitest";
import { ResolveOcrReceipt } from "./ocr-receipt.js";
import { setup, signal } from "../../v3-ocr/src/testing.fixture.js";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { ProductImageWorkflowInputSchema, observationIdentity } from "@crawl-automation/v3-contracts";

async function fixture() {
  const f = await setup(), local = new MemoryObjects();
  return { ...f, receiptLocal: local, resolver: new ResolveOcrReceipt({ results: f.results, reviews: f.reviews, local }) };
}
it("reconciles a lost OCR Activity response using registered evidence, without provider/remote writes", async () => {
  const f = await fixture(); await f.module.run(f.input, signal());
  const before = f.remote.writes, outcome = await f.resolver.run({ input: f.input, outcome: null }, signal());
  expect(outcome.status).toBe("registered"); expect(f.calls()).toBe(1); expect(f.remote.writes).toBe(before);
  expect(await new ResolveOcrReceipt({ results: f.results, reviews: f.reviews, local: new MemoryObjects() }).run({ input: f.input, outcome: null }, signal())).toEqual(outcome);
  expect(f.calls()).toBe(1); expect(f.reviews.records.size).toBe(0);
});
it("checks nominal success against exact registered result and completion", async () => {
  const f = await fixture(), outcome = await f.module.run(f.input, signal());
  expect(await f.resolver.run({ input: f.input, outcome }, signal())).toMatchObject({ status: "registered" });
  if (outcome.status !== "registered") throw Error();
  outcome.result.sha256 = "f".repeat(64);
  expect(await f.resolver.run({ input: f.input, outcome }, signal())).toMatchObject({ status: "review", code: "RECEIPT.IDENTITY_CONFLICT" });
  expect(f.calls()).toBe(1);
});
it("keeps unregistered/unknown OCR passive and never starts OCR to recover it", async () => {
  const f = await fixture();
  expect(await f.resolver.run({ input: f.input, outcome: null }, signal())).toMatchObject({ status: "review", code: "RECEIPT.OCR_UNCONFIRMED", automaticRetry: false });
  expect(f.calls()).toBe(0); expect(f.registry.writes).toBe(0); expect(f.remote.writes).toBe(0);
  const review = [...f.reviews.records.values()][0]!;
  expect(f.receiptLocal.data.has(review.failure.evidenceKey)).toBe(true);
});
it("never interprets corrupt durable evidence as an empty OCR result", async () => {
  const f = await fixture(), outcome = await f.module.run(f.input, signal());
  f.remote.data.set(f.input.file.objectKey, Buffer.from("corrupt"));
  expect(await f.resolver.run({ input: f.input, outcome }, signal())).toMatchObject({ status: "review", code: "RECEIPT.EVIDENCE_UNVERIFIED" });
  expect(f.calls()).toBe(1);
});
it("forwards verified upstream Review without appending a new review or retrying OCR", async () => {
  const f = await fixture(); vi.spyOn(f.provider, "recognize").mockRejectedValue(Error("offline"));
  const outcome = await f.module.run(f.input, signal()), before = f.reviews.records.size;
  if (outcome.status !== "review") throw Error();
  expect(await f.resolver.run({ input: f.input, outcome }, signal())).toMatchObject({ status: "review", reviewId: outcome.reviewId, code: outcome.code, operationId: outcome.operationId });
  expect(f.reviews.records.size).toBe(before); expect(f.provider.recognize).toHaveBeenCalledOnce();
});
it("rejects foreign operation receipts and unverified Review IDs", async () => {
  const f = await fixture(); vi.spyOn(f.provider, "recognize").mockRejectedValue(Error("offline"));
  const outcome = await f.module.run(f.input, signal()); if (outcome.status !== "review") throw Error();
  expect(await f.resolver.run({ input: f.input, outcome: { ...outcome, operationId: "foreign-operation" } }, signal())).toMatchObject({ status: "review", code: "RECEIPT.IDENTITY_CONFLICT" });
  expect(await f.resolver.run({ input: f.input, outcome: { ...outcome, reviewId: "missing-review" } }, signal())).toMatchObject({ status: "review", code: "RECEIPT.REVIEW_UNVERIFIED" });
});
it("lost Review append acknowledgment is reconciled by the exact ID; no second append", async () => {
  const f = await fixture(); f.reviews.lost = true;
  const append = vi.spyOn(f.reviews, "append");
  expect(await f.resolver.run({ input: f.input, outcome: null }, signal())).toMatchObject({ status: "review" });
  expect(append).toHaveBeenCalledOnce();
});
it("Review database outage cannot masquerade as a persisted Review", async () => {
  const f = await fixture(); f.reviews.unavailable = true;
  await expect(f.resolver.run({ input: f.input, outcome: null }, signal())).rejects.toThrow();
  expect(f.receiptLocal.data.size).toBe(1); expect(f.calls()).toBe(0);
});
it("owned OCR manifest rejects mixed mode, wrong owner, duplicate operations and incomplete image tasks", async () => {
  const f = await fixture(), task = f.input;
  const base = { manifest: { operationId: "product-1", observation: observationIdentity(task), imageIds: [task.file.artifactId], configFingerprint: "a".repeat(64) },
    queues: { ocr: "ocr", receipts: "receipts", keywords: "keywords", vision: "vision", assembly: "assembly", collection: "collection" }, ocrTasks: [task] };
  expect(ProductImageWorkflowInputSchema.safeParse(base).success).toBe(true);
  expect(ProductImageWorkflowInputSchema.safeParse({ ...base, ocrTasks: [] }).success).toBe(false);
  expect(ProductImageWorkflowInputSchema.safeParse({ ...base, ocrTasks: [task, task] }).success).toBe(false);
  expect(ProductImageWorkflowInputSchema.safeParse({ ...base, queues: { ...base.queues, receipts: undefined } }).success).toBe(false);
  expect(ProductImageWorkflowInputSchema.safeParse({ ...base, manifest: { ...base.manifest, observation: { ...base.manifest.observation, brandId: "other" } } }).success).toBe(false);
  await f.module.run(task, signal());
  const registration = await f.registry.read(task.operationId);
  expect(ProductImageWorkflowInputSchema.safeParse({ ...base, initialOcr: [registration] }).success).toBe(false);
});
