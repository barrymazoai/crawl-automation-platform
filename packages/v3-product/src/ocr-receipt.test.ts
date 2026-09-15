import { expect, it, vi } from "vitest";
import { ResolveOcrReceipt } from "./ocr-receipt.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCopies } from "@crawl-automation/v3-artifacts";
import { png, setup, signal } from "../../v3-ocr/src/testing.fixture.js";
import { OcrFileModule } from "../../v3-ocr/src/module.js";
import { OcrError } from "../../v3-ocr/src/ports.js";
import { FileCompletionJournal, OcrResultHandoff } from "../../v3-results/src/index.js";
import { RemoteReviews } from "../../v3-review/src/remote.js";
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

async function cloudWorker(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<ConstructorParameters<typeof OcrFileModule>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "v3-receipt-cloud-"));
  const local = await FileCopies.open(join(root, "cache")), journal = await FileCompletionJournal.open(join(root, "journal"));
  await local.retain(f.input.file, png, signal());
  const results = new OcrResultHandoff("fixture/1", local, f.remote, journal, null);
  return new OcrFileModule({ ...f.deps, results, mode: "upload-only", ...overrides });
}
it("registers cloud-mode uploaded evidence from remote bytes only, then answers registered", async () => {
  const f = await fixture(), outcome = await (await cloudWorker(f)).run(f.input, signal());
  expect(outcome.status).toBe("uploaded"); expect(f.registry.writes).toBe(0);
  const writes = f.remote.writes, r = await f.resolver.run({ input: f.input, outcome }, signal());
  expect(r.status).toBe("registered"); if (r.status !== "registered") throw Error("unreachable");
  expect(f.registry.writes).toBe(1); expect(f.remote.writes).toBe(writes); expect(f.calls()).toBe(1);
  if (outcome.status !== "uploaded") throw Error("unreachable");
  expect(r.registration.result).toEqual(outcome.result); expect(r.registration.completion).toEqual(outcome.completion);
  expect(await f.resolver.run({ input: f.input, outcome }, signal())).toEqual(r); expect(f.registry.writes).toBe(1);
});
it("an uploaded outcome whose refs do not match the remote evidence is a receipt Review, not a registration", async () => {
  const f = await fixture(), outcome = await (await cloudWorker(f)).run(f.input, signal());
  if (outcome.status !== "uploaded") throw Error("unreachable");
  const forged = { ...outcome, result: { ...outcome.result, sha256: "b".repeat(64) } };
  const r = await f.resolver.run({ input: f.input, outcome: forged }, signal());
  expect(r.status).toBe("review"); if (r.status !== "review") throw Error("unreachable");
  expect(r.code).toBe("RECEIPT.IDENTITY_CONFLICT");
});
it("a cloud-mode Review retained remotely enters the ledger through the receipt with identity checks", async () => {
  const f = await fixture(), remoteReviews = new RemoteReviews(f.remote);
  const provider = { ...f.provider, recognize: async () => { throw new OcrError("OCR.EMPTY", "executed"); } };
  const outcome = await (await cloudWorker(f, { provider, reviews: remoteReviews })).run(f.input, signal());
  expect(outcome.status).toBe("review"); if (outcome.status !== "review") throw Error("unreachable");
  expect(f.reviews.records.has(outcome.reviewId)).toBe(false);
  const resolver = new ResolveOcrReceipt({ results: f.results, reviews: f.reviews, remoteReviews, local: new MemoryObjects() });
  const r = await resolver.run({ input: f.input, outcome }, signal());
  expect(r).toMatchObject({ status: "review", reviewId: outcome.reviewId, code: "OCR.EMPTY" });
  expect(f.reviews.records.has(outcome.reviewId)).toBe(true);
  const foreign = { ...outcome, code: "OCR.UNCLASSIFIED" as const };
  const wrong = await resolver.run({ input: f.input, outcome: foreign }, signal());
  expect(wrong.status).toBe("review"); if (wrong.status !== "review") throw Error("unreachable");
  expect(wrong.code).toBe("RECEIPT.IDENTITY_CONFLICT");
});
