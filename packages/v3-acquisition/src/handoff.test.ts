import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FileCopies } from "@crawl-automation/v3-artifacts";
import { observationIdentity, parseOcrInput, ProductImageWorkflowInputSchema, type FileOcrPlan } from "@crawl-automation/v3-contracts";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { MemoryReviews } from "../../v3-ocr/src/testing.fixture.js";
import { fileInput, lease, response, png } from "./testing.fixture.js";
import { AcquireFileModule, PrepareImageOcr, FileEvidence, ResolveAcquiredFile, acquiredImageId, acquisitionKey } from "./handoff.js";
import { hash } from "./core.js";
import { StaticDirectSources } from "./static-source.js";
const signal = () => AbortSignal.timeout(5000);
async function setup() {
  const input = fileInput(), local = new MemoryObjects(), remote = new MemoryObjects(), reviews = new MemoryReviews();
  const copies = await FileCopies.open(await mkdtemp(join(tmpdir(), "v3-acquire-unit-")));
  const get = vi.fn(async () => response()), access = { acquire: async () => lease(get) }, dns = { resolve: async () => [{ address: "8.8.8.8", family: 4 as const }] };
  const deps = { local, remote, copies, reviews }, evidence = new FileEvidence(deps);
  const plan: FileOcrPlan = { acquire: input, imageId: acquiredImageId(input.operationId), ocrOperationId: "ocr-op-1",
    ocr: { module: "ocr.file", schemaVersion: 1, resultSchemaVersion: 2, implementationVersion: "ocr/1", policyVersion: "policy/1", configFingerprint: "a".repeat(64) } };
  return { input, local, remote, reviews, copies, get, deps, evidence, plan,
    source: { access, dns }, acquire: new AcquireFileModule(evidence, { access, dns }), prepare: new PrepareImageOcr(evidence) };
}
it("durable download replays on an empty-cache node without source HTTP or PUT", async () => {
  const f = await setup(), outcome = await f.acquire.run(f.input, signal()), writes = f.remote.writes;
  expect(outcome.status).toBe("durable");
  const e = new FileEvidence({ ...f.deps, local: new MemoryObjects(), copies: await FileCopies.open(await mkdtemp(join(tmpdir(), "v3-acquire-replacement-"))) });
  expect(await new AcquireFileModule(e, f.source).run(f.input, signal())).toEqual(outcome);
  expect(f.get).toHaveBeenCalledOnce(); expect(f.remote.writes).toBe(writes);
});
it("read-only receipt returns durable evidence with no source port, PUT or new Review", async () => {
  const f=await setup(), outcome=await f.acquire.run(f.input,signal()), writes=f.remote.writes;
  const receipt=new ResolveAcquiredFile(new FileEvidence({...f.deps,local:new MemoryObjects()}));
  expect(await receipt.run(f.input,signal())).toEqual(outcome);
  expect(await receipt.run(f.input,signal())).toEqual(outcome);
  expect(f.get).toHaveBeenCalledOnce();expect(f.remote.writes).toBe(writes);expect(f.reviews.records.size).toBe(0);
});
it("missing read-only receipt never creates execution intent or downloads",async()=>{
  const f=await setup();await expect(new ResolveAcquiredFile(f.evidence).run(f.input,signal())).rejects.toThrow("ACQUIRE.NOT_DURABLE");
  expect(f.get).not.toHaveBeenCalled();expect(f.remote.writes).toBe(0);expect(f.reviews.records.size).toBe(0);
});
it("read-only receipt rejects invalid inputs before inspecting and late cancellation",async()=>{
  const inspect=vi.fn(async()=>null),module=new ResolveAcquiredFile({inspect});
  await expect(module.run({...fileInput(),url:"https://unapproved.example"},signal())).rejects.toThrow();expect(inspect).not.toHaveBeenCalled();
  const c=new AbortController();inspect.mockImplementationOnce(async()=>{c.abort(Error("cancelled"));return null;});
  await expect(module.run(fileInput(),c.signal)).rejects.toThrow("cancelled");
});
it("concurrent same-operation consumers never perform two downloads", async () => {
  const f = await setup();
  const outcomes = await Promise.all([f.acquire.run(f.input, signal()), new AcquireFileModule(f.evidence, f.source).run(f.input, signal())]);
  expect(outcomes.some(r => r.status === "durable")).toBe(true); expect(f.get).toHaveBeenCalledOnce();
});
it("HTTP failure remains passive across redelivery and fresh local journal", async () => {
  const f = await setup(); f.get.mockImplementation(async () => response(png, {}, 403));
  expect(await f.acquire.run(f.input, signal())).toMatchObject({ status: "review", code: "SOURCE.HTTP_STATUS" });
  expect(await new AcquireFileModule(new FileEvidence({ ...f.deps, local: new MemoryObjects() }), f.source).run(f.input, signal())).toMatchObject({ status: "review", code: "ACQUIRE.EXECUTION_UNKNOWN" });
  expect(f.get).toHaveBeenCalledOnce();
});
it("Review readback tolerates jsonb object key ordering but rejects changed values", async () => {
  const f = await setup(); f.get.mockImplementation(async () => response(png, {}, 403));
  const read = f.reviews.read.bind(f.reviews);
  const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  vi.spyOn(f.reviews, "read").mockImplementation(async id => reorder(await read(id)) as Awaited<ReturnType<typeof read>>);
  expect(await f.acquire.run(f.input, signal())).toMatchObject({ status: "review", code: "SOURCE.HTTP_STATUS" });
  vi.mocked(f.reviews.read).mockImplementation(async id => {
    const record = structuredClone(await read(id));
    if (record) record.rawError.message = "changed";
    return record;
  });
  await expect(f.acquire.run(f.input, signal())).rejects.toThrow("ACQUIRE.REVIEW_UNVERIFIED");
  expect(f.get).toHaveBeenCalledOnce();
});
it("lost intent PUT acknowledgment cannot authorize a source request", async () => {
  const f = await setup(); f.remote.unknown = true;
  expect(await f.acquire.run(f.input, signal())).toMatchObject({ status: "review", code: "ACQUIRE.INTENT_UNKNOWN" });
  f.remote.unknown = false;
  expect(await f.acquire.run(f.input, signal())).toMatchObject({ status: "review" }); expect(f.get).not.toHaveBeenCalled();
});
it("failed file publication retains original bytes and candidate; redelivery does not download/upload again", async () => {
  const f = await setup(), create = f.remote.create.bind(f.remote);
  vi.spyOn(f.remote, "create").mockImplementation(async (key, bytes) => { if (key.endsWith("/source")) throw Error("offline"); return create(key, bytes); });
  expect(await f.acquire.run(f.input, signal())).toMatchObject({ status: "review" });
  const review = [...f.reviews.records.values()][0]!, record = review.candidate!.value as { file: Parameters<typeof f.copies.read>[0] };
  expect(await f.copies.read(record.file, signal())).toEqual(png);
  const writes = f.remote.writes;
  expect(await f.acquire.run(f.input, signal())).toMatchObject({ status: "review" });
  expect(f.get).toHaveBeenCalledOnce(); expect(f.remote.writes).toBe(writes + 1); // only the conditional existing-intent claim
});
it("lost completion PUT acknowledgment is reconciled with one GET rather than another download", async () => {
  const f = await setup(), create = f.remote.create.bind(f.remote);
  vi.spyOn(f.remote, "create").mockImplementation(async (key, bytes) => { const r = await create(key, bytes); if (key === acquisitionKey(f.input)) throw Error("lost ack"); return r; });
  expect(await f.acquire.run(f.input, signal())).toMatchObject({ status: "durable" }); expect(f.get).toHaveBeenCalledOnce();
});
it("corrupt remote original is rejected even when a completion marker exists", async () => {
  const f = await setup(), result = await f.acquire.run(f.input, signal()); if (result.status !== "durable") throw Error();
  f.remote.data.set(result.file.objectKey, Buffer.from("corrupt"));
  expect(await f.acquire.run(f.input, signal())).toMatchObject({ status: "review" }); expect(f.get).toHaveBeenCalledOnce();
});
it("independent preparation accepts only verified image bytes and builds a correctly signed OCR input", async () => {
  const f = await setup(), receipt = await f.acquire.run(f.input, signal());
  const prepared = await f.prepare.run({ plan: f.plan, receipt: null }, signal());
  expect(prepared.status).toBe("prepared"); if (prepared.status !== "prepared") throw Error();
  expect(parseOcrInput(prepared.task, hash).file.sha256).toBe(hash(png)); expect(prepared.task.operationId).toBe("ocr-op-1");
  const writes = f.remote.writes;
  expect(await new PrepareImageOcr(new FileEvidence({ ...f.deps, local: new MemoryObjects() })).run({ plan: f.plan, receipt }, signal())).toEqual(prepared);
  expect(f.remote.writes).toBe(writes); expect(f.get).toHaveBeenCalledOnce();
});
it("preparation propagates the original verified Review, but rejects foreign image identity", async () => {
  const f = await setup(); f.get.mockImplementation(async () => response(png, {}, 403));
  const receipt = await f.acquire.run(f.input, signal()), before = f.reviews.records.size;
  expect(await f.prepare.run({ plan: f.plan, receipt }, signal())).toEqual(receipt); expect(f.reviews.records.size).toBe(before);
  expect(await f.prepare.run({ plan: { ...f.plan, imageId: "foreign-image" }, receipt }, signal())).toMatchObject({ status: "review", code: "IMAGE.IDENTITY_CONFLICT" });
});
it("PDF is preserved but never masquerades as a directly OCR-ready image", async () => {
  const f = await setup(); f.get.mockImplementation(async () => response(Buffer.from("%PDF-1.4\n%%EOF\n"), { "content-type": "application/pdf" }));
  const receipt = await f.acquire.run(f.input, signal()); expect(receipt.status).toBe("durable");
  expect(await f.prepare.run({ plan: f.plan, receipt }, signal())).toMatchObject({ status: "review", code: "IMAGE.PDF_ROUTE_REQUIRED" });
});
it("Review outage throws and preserves local evidence; private URL/headers never enter error data", async () => {
  const f = await setup(); f.get.mockRejectedValue(Error("private-cookie-canary")); f.reviews.unavailable = true;
  await expect(f.acquire.run(f.input, signal())).rejects.toThrow();
  expect(f.local.data.size).toBe(1); expect(JSON.stringify([...f.local.data.values()].map(v => Buffer.from(v).toString()))).not.toContain("private-cookie-canary");
});
it("static public source catalog enforces owner, explicit direct binding, expiry and independent lease release", async () => {
  const input = fileInput(), raw = { owner: observationIdentity(input), resourceId: input.resourceId, binding: input.binding,
    url: "https://files.example/image", allowedOrigins: ["https://files.example"], expiresAt: "2099-01-01T00:00:00Z" };
  const access = new StaticDirectSources([raw]), a = await access.acquire(input, signal()), b = await access.acquire(input, signal());
  await a.release(); expect(() => a.assertActive()).toThrow(); expect(() => b.assertActive()).not.toThrow(); expect(b.headersFor("https://files.example")).toEqual({});
  await expect(access.acquire({ ...input, brandId: "wrong" }, signal())).rejects.toThrow();
  expect(() => new StaticDirectSources([{ ...raw, binding: { ...raw.binding, egressId: "clash/1" } }])).toThrow();
  await expect(new StaticDirectSources([{ ...raw, expiresAt: "2000-01-01T00:00:00Z" }]).acquire(input, signal())).rejects.toThrow();
  expect(() => new StaticDirectSources([{ ...raw, url: "https://127.0.0.1/image", allowedOrigins: ["https://127.0.0.1"] }])).toThrow();
});
it("file-mode workflow contract rejects mixed modes, incomplete manifests and cross-product or duplicate operations", async () => {
  const f = await setup(), raw = { manifest: { operationId: "product-1", observation: observationIdentity(f.input),
    imageIds: [f.plan.imageId], configFingerprint: "a".repeat(64) }, fileTasks: [f.plan],
    queues: { acquire: "acquire", prepare: "prepare", ocr: "ocr", receipts: "receipts", keywords: "keywords", vision: "vision", assembly: "assembly", collection: "collection" } };
  expect(ProductImageWorkflowInputSchema.safeParse(raw).success).toBe(true);
  for (const invalid of [
    { ...raw, ocrTasks: [] }, { ...raw, fileTasks: [] }, { ...raw, fileTasks: [f.plan, f.plan] },
    { ...raw, queues: { ...raw.queues, prepare: undefined } },
    { ...raw, fileTasks: [{ ...f.plan, ocrOperationId: f.input.operationId }] },
    { ...raw, fileTasks: [{ ...f.plan, acquire: { ...f.input, brandId: "foreign-brand" } }] },
    { ...raw, fileTasks: [{ ...f.plan, ocr: { ...f.plan.ocr, resultSchemaVersion: 1 } }] },
  ]) expect(ProductImageWorkflowInputSchema.safeParse(invalid).success).toBe(false);
});
