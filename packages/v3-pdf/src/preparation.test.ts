import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, expect, vi } from "vitest";
import { FileCopies, sha256 } from "@crawl-automation/v3-artifacts";
import { PdfPagesPrepareOutcomeSchema, PdfOcrPrepareOutcomeSchema, parseOcrInput, ProductImageWorkflowInputSchema, observationIdentity } from "@crawl-automation/v3-contracts";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { MemoryReviews } from "../../v3-ocr/src/testing.fixture.js";
import { nutritionPdf, inputFor } from "../integration/helpers.js";
import { PdfModule, PdfPreparation, PdfSubprocess } from "./index.js";
const signal = () => AbortSignal.timeout(10000);
async function setup(count = 2) {
  const root = await mkdtemp(join(tmpdir(), "v3-pdf-pages-")), bytes = nutritionPdf(count), inspection = inputFor(bytes, "pdf.inspect", "inspect-pdf");
  const remote = new MemoryObjects(), journal = new MemoryObjects(), reviews = new MemoryReviews(); remote.data.set(inspection.pdf.objectKey, bytes);
  const deps = { remote, journal, reviews, copies: await FileCopies.open(join(root, "cache")) };
  const engine = await PdfSubprocess.open({ pythonExecutable: resolve(".venv/bin/python"), workRoot: join(root, "attempts") }), run = vi.spyOn(engine, "run");
  const module = new PdfModule(deps, engine), prep = new PdfPreparation(deps);
  const plan = { operationId: "product-pdf", inspection, scale: 1,
    ocr: { schemaVersion: 1 as const, module: "ocr.file" as const, implementationVersion: "ocr/1", policyVersion: "policy/1", resultSchemaVersion: 2, configFingerprint: "a".repeat(64) }, configFingerprint: "b".repeat(64) };
  return { root, deps, module, prep, plan, run };
}
it("verified inspection produces complete deterministic pages, and render builds hash-bound single-page OCR input", async () => {
  const f = await setup(), receipt = await f.module.run(f.plan.inspection, signal());
  const out = PdfPagesPrepareOutcomeSchema.parse(await f.prep.pages({ plan: f.plan, receipt }, signal()));
  if (out.status !== "planned") throw Error(); expect(out.pages).toHaveLength(2);
  const writes = f.deps.remote.writes;
  expect(await new PdfPreparation({ ...f.deps, journal: new MemoryObjects() }).pages({ plan: f.plan, receipt: null }, signal())).toEqual(out);
  expect(f.deps.remote.writes).toBe(writes); expect(f.run).toHaveBeenCalledOnce();
  const page = out.pages[1]!, rendered = await f.module.run(page.render, signal());
  const prepared = PdfOcrPrepareOutcomeSchema.parse(await f.prep.ocr({ plan: page, receipt: null }, signal()));
  if (prepared.status !== "prepared") throw Error();
  expect(parseOcrInput(prepared.task, s => sha256(Buffer.from(s))).file).toMatchObject({ kind: "pdf-page", pageIndex: 1, parentArtifactId: f.plan.inspection.pdf.artifactId });
  const after = f.deps.remote.writes;
  expect(await f.prep.ocr({ plan: page, receipt: rendered }, signal())).toEqual(prepared);
  expect(f.deps.remote.writes).toBe(after); expect(f.run).toHaveBeenCalledTimes(2);
});
it("unconfirmed inspection and more than 100 pages stop before rendering rather than silently truncate", async () => {
  const f = await setup(101);
  expect(await f.prep.pages({ plan: f.plan, receipt: null }, signal())).toMatchObject({ status: "review", code: "PDF.NOT_DURABLE" });
  expect(f.run).not.toHaveBeenCalled();
  const receipt = await f.module.run(f.plan.inspection, signal());
  expect(await f.prep.pages({ plan: f.plan, receipt }, signal())).toMatchObject({ status: "review", code: "PDF.PRODUCT_PAGE_LIMIT" });
  expect(f.run).toHaveBeenCalledOnce();
});
it("verified upstream Review is reused; forged operation and evidence refs are rejected", async () => {
  const f = await setup(); f.deps.remote.data.delete(f.plan.inspection.pdf.objectKey);
  const receipt = await f.module.run(f.plan.inspection, signal()), before = f.deps.reviews.records.size;
  expect(await f.prep.pages({ plan: f.plan, receipt }, signal())).toEqual(receipt); expect(f.deps.reviews.records.size).toBe(before);
  expect(await f.prep.pages({ plan: f.plan, receipt: { ...receipt, operationId: "foreign" } }, signal())).toMatchObject({ status: "review", code: "PDF.IDENTITY_CONFLICT" });
  expect(await f.prep.pages({ plan: f.plan, receipt: { ...receipt, evidenceKey: "foreign/key" } }, signal())).toMatchObject({ status: "review", code: "PDF.IDENTITY_CONFLICT" });
  expect(f.run).not.toHaveBeenCalled();
});
it("plan publication failure remains pending on replay; no hidden engine call or automatic PUT", async () => {
  const f = await setup(); await f.module.run(f.plan.inspection, signal());
  const create = f.deps.remote.create.bind(f.deps.remote);
  vi.spyOn(f.deps.remote, "create").mockImplementation(async (key, bytes) => { if (key.endsWith("pages.json")) throw Error("offline"); return create(key, bytes); });
  expect(await f.prep.pages({ plan: f.plan, receipt: null }, signal())).toMatchObject({ status: "review" });
  expect(await f.prep.pages({ plan: f.plan, receipt: null }, signal())).toMatchObject({ status: "review", code: "PDF.HANDOFF_PENDING" });
  expect(f.run).toHaveBeenCalledOnce(); expect(vi.mocked(f.deps.remote.create).mock.calls.filter(([key]) => key.endsWith("pages.json"))).toHaveLength(1);
});
it("page workflow rejects mixed modes, missing/duplicate pages and foreign ownership", async () => {
  const f = await setup(); await f.module.run(f.plan.inspection, signal());
  const out = await f.prep.pages({ plan: f.plan, receipt: null }, signal()); if (out.status !== "planned") throw Error();
  const input = { manifest: { operationId: f.plan.operationId, observation: observationIdentity(f.plan.inspection), imageIds: out.pages.map(p => p.imageId), configFingerprint: f.plan.configFingerprint },
    pdfTasks: out.pages, queues: { pdfRender: "render", pdfPrepare: "prepare", ocr: "ocr", receipts: "receipts", keywords: "keywords", vision: "vision", assembly: "assembly", collection: "collection" } };
  expect(ProductImageWorkflowInputSchema.safeParse(input).success).toBe(true);
  for (const wrong of [{ ...input, ocrTasks: [] }, { ...input, fileTasks: [] }, { ...input, pdfTasks: [out.pages[0]] },
    { ...input, pdfTasks: [out.pages[0], out.pages[0]] }, { ...input, queues: { ...input.queues, pdfPrepare: undefined } },
    { ...input, manifest: { ...input.manifest, observation: { ...input.manifest.observation, brandId: "foreign" } } }])
    expect(ProductImageWorkflowInputSchema.safeParse(wrong).success).toBe(false);
});
