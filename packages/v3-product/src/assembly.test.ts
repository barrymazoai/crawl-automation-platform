import { expect, it, vi } from "vitest";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { candidate, selection, observation, bytes } from "../../v3-vision/src/testing.fixture.js";
import { KeywordPublication, VisionModule, VisionHandoff, type VisionRegistry } from "@crawl-automation/v3-vision";
import { type CollectedProduct, type ProductImageJoin, type VisionRecord } from "@crawl-automation/v3-contracts";
import { ProductImageAssembly } from "./assembly.js";
import { CollectProduct, collectedHash } from "./collection.js";
async function setup(text = "Supplement Facts") {
  const local = new MemoryObjects(), remote = new MemoryObjects(), selected = selection(text), signal = AbortSignal.timeout(5000);
  const published = await new KeywordPublication(local, remote).publish(selected, signal);
  remote.data.set(selected.image.objectKey, bytes);
  const task = { input: { operationId: "vision-1", selection: selected }, configFingerprint: "a".repeat(64) };
  const records = new Map<string, VisionRecord>(), registry: VisionRegistry = {
    read: async id => records.get(id) ?? null, register: async r => { records.set(r.input.operationId, r); } };
  const handoff = new VisionHandoff(local, remote, registry, "test/1", async () => {});
  if (selected.status === "matched") {
    await new VisionModule({ provider: { fingerprint: task.configFingerprint, interpret: async () => JSON.stringify(candidate) },
      localEvidence: local, store: remote, verifiedOcrText: async () => text, resolve: async () => bytes }).run(task.input, signal);
    await handoff.complete(task, signal);
  }
  const keyword = { status: selected.status, imageId: selected.image.artifactId, selection: selected, ...published };
  const input: ProductImageJoin = { manifest: { operationId: "product-1", observation, imageIds: [selected.image.artifactId], configFingerprint: task.configFingerprint },
    images: selected.status === "matched" ? [{ status: "registered", imageId: selected.image.artifactId, keyword, task }]
      : [{ status: "not_matched", imageId: selected.image.artifactId, keyword }] };
  const reviews = { append: vi.fn(async () => ({ reviewId: "review-1" })) };
  const deps = { local, remote, reviews, ocr: { verifiedText: async () => text }, vision: handoff };
  return { input, deps, reviews, local, remote, signal, service: new ProductImageAssembly(deps) };
}
it("assembles verified result refs; fresh local cache replays without writes or model access", async () => {
  const f = await setup(), receipt = await f.service.run(f.input, f.signal), before = f.remote.writes;
  expect(receipt.status).toBe("ready"); expect(f.reviews.append).not.toHaveBeenCalled();
  expect(await new ProductImageAssembly({ ...f.deps, local: new MemoryObjects() }).run(f.input, f.signal)).toEqual(receipt);
  expect(f.remote.writes).toBe(before);
});
it("all unmatched stores passive no-label Review and never tries reading vision", async () => {
  const f = await setup("marketing"), read = vi.spyOn(f.deps.vision, "readCandidate");
  const result = await f.service.run(f.input, f.signal);
  expect(result).toMatchObject({ status: "review", codes: expect.arrayContaining(["SCREEN.NO_LABEL_EVIDENCE"]), automaticRetry: false });
  expect(f.reviews.append).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
});
it("missing/corrupted evidence becomes review rather than a fabricated empty candidate", async () => {
  const f = await setup(); f.remote.data.set(f.input.images[0]!.status === "registered" ? f.input.images[0]!.keyword.evidenceKey : "never", Buffer.from("invalid"));
  expect(await f.service.run(f.input, f.signal)).toMatchObject({ status: "review", codes: expect.arrayContaining(["PRODUCT.EVIDENCE_UNRESOLVED"]) });
});
it("incomplete barrier and duplicate image cannot be published as successful completion", async () => {
  const f = await setup();
  expect(await f.service.run({ ...f.input, images: [] }, f.signal)).toMatchObject({ status: "review", codes: ["PRODUCT.BARRIER_INCOMPLETE"] });
  expect(await f.service.run({ ...f.input, images: [...f.input.images, ...f.input.images] }, f.signal)).toMatchObject({ status: "review", codes: ["PRODUCT.IDENTITY_CONFLICT"] });
});
it("failed assembly upload is retained and becomes passive Review without automatic re-PUT", async () => {
  const f = await setup(), original = f.remote.create.bind(f.remote);
  const create = vi.spyOn(f.remote, "create").mockRejectedValue(Error("offline"));
  expect(await f.service.run(f.input, f.signal)).toMatchObject({ status: "review", codes: ["PRODUCT.HANDOFF_UNVERIFIED"] });
  create.mockImplementation(original);
  expect(await f.service.run(f.input, f.signal)).toMatchObject({ status: "review", codes: ["PRODUCT.HANDOFF_PENDING"] });
  expect(create).toHaveBeenCalledOnce();
});
it("lost Review acknowledgment is not retried with a different Review ID", async () => {
  const f = await setup("marketing"); f.reviews.append.mockRejectedValueOnce(Error("lost acknowledgment"));
  await expect(f.service.run(f.input, f.signal)).rejects.toThrow("PRODUCT.REVIEW_UNVERIFIED");
  expect(f.reviews.append).toHaveBeenCalledOnce();
});
it("an upstream error remains its own classified Review, never all-unmatched", async () => {
  const f = await setup(); f.input.images = [{ status: "review", imageId: f.input.manifest.imageIds[0]!, code: "OCR.EXECUTION_UNKNOWN", reviewId: "ocr-review" }];
  const r = await f.service.run(f.input, f.signal);
  expect(r).toMatchObject({ status: "review", codes: expect.arrayContaining(["OCR.EXECUTION_UNKNOWN"]) });
  if (r.status !== "review") throw Error(); expect(r.codes).not.toContain("SCREEN.NO_LABEL_EVIDENCE");
});
async function collectionSetup() {
  const f = await setup(), receipt = await f.service.run(f.input, f.signal), records = new Map<string, CollectedProduct>();
  const registry = { read: vi.fn(async (id: string) => records.get(id) ?? null),
    append: vi.fn(async (r: CollectedProduct) => { records.set(r.operationId, structuredClone(r)); }) };
  const deps = { assembly: f.service, local: new MemoryObjects(), reviews: f.reviews, registry };
  return { ...f, records, registry, collectionDeps: deps, collect: new CollectProduct(deps),
    collectionInput: { join: f.input, evidenceKey: receipt.evidenceKey } };
}
it("collects core sections without company mapping; fresh-cache replay performs no second INSERT or remote PUT", async () => {
  const f = await collectionSetup(), writes = f.remote.writes;
  const receipt = await f.collect.run(f.collectionInput, f.signal);
  expect(receipt).toMatchObject({ status: "collected", operationId: "product-1", observationId: observation.observationId });
  const saved = f.records.get("product-1")!;
  expect(saved).not.toHaveProperty("companyId"); expect(saved.formula).toEqual(candidate.formula);
  expect(saved.ingredients).toEqual(candidate.ingredients);
  expect(await new CollectProduct({ ...f.collectionDeps, local: new MemoryObjects() }).run(f.collectionInput, f.signal)).toEqual(receipt);
  expect(f.registry.append).toHaveBeenCalledOnce(); expect(f.remote.writes).toBe(writes); expect(f.reviews.append).not.toHaveBeenCalled();
});
it("lost database commit acknowledgment is resolved by readback, without second INSERT", async () => {
  const f = await collectionSetup();
  f.registry.append.mockImplementationOnce(async r => { f.records.set(r.operationId, r); throw Error("lost response"); });
  expect(await f.collect.run(f.collectionInput, f.signal)).toMatchObject({ status: "collected" });
  expect(f.registry.append).toHaveBeenCalledOnce(); expect(f.reviews.append).not.toHaveBeenCalled();
});
it("unconfirmed INSERT retains full candidate and redelivery remains passive, without retry", async () => {
  const f = await collectionSetup(); f.registry.append.mockRejectedValue(Error("offline"));
  expect(await f.collect.run(f.collectionInput, f.signal)).toMatchObject({ status: "review", codes: ["COLLECTION.REGISTRATION_UNKNOWN"] });
  expect(await f.collect.run(f.collectionInput, f.signal)).toMatchObject({ status: "review", codes: ["COLLECTION.HANDOFF_PENDING"] });
  expect(f.registry.append).toHaveBeenCalledOnce();
  expect([...f.collectionDeps.local.data.keys()]).toContain("collection-journal/product-1.json");
});
it("corrupted or missing assembly bytes cannot be collected", async () => {
  const f = await collectionSetup(); f.remote.data.set(f.collectionInput.evidenceKey, Buffer.from("{}"));
  expect(await f.collect.run(f.collectionInput, f.signal)).toMatchObject({ status: "review", codes: ["COLLECTION.EVIDENCE_UNVERIFIED"] });
  expect(f.registry.append).not.toHaveBeenCalled();
});
it("rechecking original source evidence prevents collection even if the assembly receipt is valid", async () => {
  const f = await collectionSetup(); f.remote.data.set(selection().image.objectKey, Buffer.from("corrupt source"));
  expect(await f.collect.run(f.collectionInput, f.signal)).toMatchObject({ status: "review", codes: ["COLLECTION.NOT_READY"] });
  expect(f.registry.append).not.toHaveBeenCalled();
});
it("a no-label assembly cannot be collected", async () => {
  const f = await setup("marketing"), receipt = await f.service.run(f.input, f.signal), append = vi.fn();
  const c = new CollectProduct({ assembly: f.service, local: f.local, reviews: f.reviews, registry: { read: async () => null, append } });
  expect(await c.run({ join: f.input, evidenceKey: receipt.evidenceKey }, f.signal)).toMatchObject({ status: "review", codes: ["COLLECTION.NOT_READY"] });
  expect(append).not.toHaveBeenCalled();
});
it("conflicting saved snapshot is preserved, never overwritten", async () => {
  const f = await collectionSetup(); await f.collect.run(f.collectionInput, f.signal);
  const original = f.records.get("product-1")!;
  f.records.set("product-1", { ...original, assembly: { ...original.assembly, sha256: "f".repeat(64) } });
  const hash = collectedHash(f.records.get("product-1"));
  expect(await f.collect.run(f.collectionInput, f.signal)).toMatchObject({ status: "review", codes: ["COLLECTION.RESULT_CONFLICT"] });
  expect(collectedHash(f.records.get("product-1"))).toBe(hash); expect(f.registry.append).toHaveBeenCalledOnce();
});
it("collection Review persistence failure is not reported as a saved Review", async () => {
  const f = await collectionSetup(); f.remote.data.set(f.collectionInput.evidenceKey, Buffer.from("{}"));
  f.reviews.append.mockRejectedValueOnce(Error("lost review response"));
  await expect(f.collect.run(f.collectionInput, f.signal)).rejects.toThrow("lost review response");
  expect(f.reviews.append).toHaveBeenCalledOnce();
});
