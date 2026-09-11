import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, expect, vi } from "vitest";
import { FileCopies, sha256 } from "@crawl-automation/v3-artifacts";
import { PdfTextPlanSchema, PdfTextPrepareOutcomeSchema, TextDocumentSchema, parseTextInput } from "@crawl-automation/v3-contracts";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { MemoryReviews } from "../../v3-ocr/src/testing.fixture.js";
import { nutritionPdf, inputFor } from "../integration/helpers.js";
import { PdfModule, PdfTextPreparation, PdfTextEvidence, PdfEvidence, PdfSubprocess, pdfTextInputKey, pdfCompletionKey } from "./index.js";
const signal = () => AbortSignal.timeout(10000);
const hash = (s: string) => sha256(Buffer.from(s));
async function setup(content?: string) {
  const root = await mkdtemp(join(tmpdir(), "v3-pdf-text-")), bytes = nutritionPdf(2, content), extraction = inputFor(bytes, "pdf.text", "extract", 1);
  const remote = new MemoryObjects(), journal = new MemoryObjects(), reviews = new MemoryReviews(); remote.data.set(extraction.pdf.objectKey, bytes);
  const deps = { remote, journal, reviews, copies: await FileCopies.open(join(root, "cache")) };
  const engine = await PdfSubprocess.open({ pythonExecutable: resolve(".venv/bin/python"), workRoot: join(root, "attempts") }), run = vi.spyOn(engine, "run");
  const module = new PdfModule(deps, engine), prep = new PdfTextPreparation(deps);
  const plan = PdfTextPlanSchema.parse({ extraction, textOperationId: "interpret", text: { schemaVersion: 1, module: "codex.text",
    implementationVersion: "text/1", policyVersion: "policy/1", resultSchemaVersion: 2, configFingerprint: "a".repeat(64) } });
  return { deps, module, prep, plan, run };
}
it("real PDFium text becomes a full-range document with parent and page retained; empty-cache reuse is read-only", async () => {
  const f = await setup(), receipt = await f.module.run(f.plan.extraction, signal());
  const out = PdfTextPrepareOutcomeSchema.parse(await f.prep.run({ plan: f.plan, receipt }, signal()));
  if (out.status !== "prepared" || out.task.source.kind !== "prepared" || receipt.status !== "durable") throw Error();
  expect(parseTextInput(out.task, hash)).toEqual(out.task);
  const document = TextDocumentSchema.parse(JSON.parse(Buffer.from(f.deps.remote.data.get(out.task.source.document.objectKey)!).toString()));
  const original = JSON.parse(Buffer.from(f.deps.remote.data.get(receipt.artifact.objectKey)!).toString());
  expect(document.text).toBe(original.text); expect(document.text).toContain("Supplement Facts");
  expect(document.pageIndex).toBe(1); expect(document.source).toEqual(f.plan.extraction.pdf);
  expect(out.task.range).toEqual({ start: 0, end: document.text.length });
  const writes = f.deps.remote.writes;
  expect(await new PdfTextEvidence(f.deps.remote, new PdfEvidence(f.deps)).inspect(f.plan, signal())).toEqual(out.task);
  expect(await new PdfTextPreparation({ ...f.deps, journal: new MemoryObjects() }).run({ plan: f.plan, receipt: null }, signal())).toEqual(out);
  expect(f.deps.remote.writes).toBe(writes); expect(f.run).toHaveBeenCalledOnce();
});
it("missing completion and real empty PDF page stop without implicit OCR or re-extraction", async () => {
  const f = await setup("");
  expect(await f.prep.run({ plan: f.plan, receipt: null }, signal())).toMatchObject({ status: "review", code: "PDF.NOT_DURABLE" });
  expect(f.run).not.toHaveBeenCalled();
  const receipt = await f.module.run(f.plan.extraction, signal());
  expect(receipt.status).toBe("durable");
  expect(await f.prep.run({ plan: f.plan, receipt }, signal())).toMatchObject({ status: "review", code: "PDF.TEXT_EMPTY" });
  const review = [...f.deps.reviews.records.values()].at(-1)!;
  expect(review.failure.stage).toBe("pdf.text-input"); expect(review.rawError.details).toMatchObject({ plan: f.plan });
  expect(f.run).toHaveBeenCalledOnce(); expect(f.deps.remote.data.has(pdfTextInputKey(f.plan))).toBe(false);
});
it("explicit extraction Review remains Review; wrong operation, evidence or classification cannot be reused", async () => {
  const f = await setup(); f.deps.remote.data.delete(f.plan.extraction.pdf.objectKey);
  const receipt = await f.module.run(f.plan.extraction, signal()); if (receipt.status !== "review") throw Error();
  const size = f.deps.reviews.records.size;
  expect(await f.prep.run({ plan: f.plan, receipt }, signal())).toEqual(receipt); expect(f.deps.reviews.records.size).toBe(size);
  for (const mutation of [{ operationId: "foreign" }, { evidenceKey: "foreign/key" }, { code: "PDF.TEXT_EMPTY" }])
    expect(await f.prep.run({ plan: f.plan, receipt: { ...receipt, ...mutation } }, signal())).toMatchObject({ status: "review", code: "PDF.IDENTITY_CONFLICT" });
  expect(f.run).not.toHaveBeenCalled();
});
it.each(["source", "output", "completion", "document", "plan"])("corrupt %s evidence cannot be accepted by a replacement", async part => {
  const f = await setup(), receipt = await f.module.run(f.plan.extraction, signal());
  const out = await f.prep.run({ plan: f.plan, receipt }, signal());
  if (out.status !== "prepared" || out.task.source.kind !== "prepared" || receipt.status !== "durable") throw Error();
  const key = { source: f.plan.extraction.pdf.objectKey, output: receipt.artifact.objectKey, completion: pdfCompletionKey(f.plan.extraction),
    document: out.task.source.document.objectKey, plan: out.evidenceKey }[part]!;
  f.deps.remote.data.set(key, Buffer.from("corrupt")); const writes = f.deps.remote.writes;
  await expect(new PdfTextEvidence(f.deps.remote, new PdfEvidence(f.deps)).inspect(f.plan, signal())).rejects.toThrow();
  expect(await new PdfTextPreparation({ ...f.deps, journal: new MemoryObjects() }).run({ plan: f.plan, receipt: null }, signal())).toMatchObject({ status: "review" });
  expect(f.deps.remote.writes).toBe(writes); expect(f.run).toHaveBeenCalledOnce();
});
it("read-only inspector rejects replaced page, range, configuration and original completion in the task manifest", async () => {
  const f = await setup(); await f.module.run(f.plan.extraction, signal());
  await f.prep.run({ plan: f.plan, receipt: null }, signal());
  const key = pdfTextInputKey(f.plan), original = JSON.parse(Buffer.from(f.deps.remote.data.get(key)!).toString());
  const inspector = new PdfTextEvidence(f.deps.remote, new PdfEvidence(f.deps)), writes = f.deps.remote.writes;
  for (const change of [
    { ...original, plan: { ...original.plan, extraction: { ...original.plan.extraction, pageIndex: 0 } } },
    { ...original, task: { ...original.task, range: { start: 0, end: 1 } } },
    { ...original, task: { ...original.task, configFingerprint: "f".repeat(64) } },
    { ...original, extraction: { ...original.extraction, manifest: { ...original.extraction.manifest, pageIndex: 0 } } },
  ]) {
    f.deps.remote.data.set(key, Buffer.from(JSON.stringify(change)));
    await expect(inspector.inspect(f.plan, signal())).rejects.toThrow("PDF.TEXT_INPUT_UNVERIFIED");
  }
  expect(f.deps.remote.writes).toBe(writes); expect(f.run).toHaveBeenCalledOnce();
});
it.each(["document", "plan"])("unknown %s publication is never repeated from an empty-cache node", async part => {
  const f = await setup(); await f.module.run(f.plan.extraction, signal());
  const create = f.deps.remote.create.bind(f.deps.remote), suffix = part === "document" ? "/document.json" : "/input.json";
  const put = vi.spyOn(f.deps.remote, "create").mockImplementation(async (key, bytes) => { if (key.endsWith(suffix)) throw Error("offline"); return create(key, bytes); });
  expect(await f.prep.run({ plan: f.plan, receipt: null }, signal())).toMatchObject({ status: "review", code: "PDF.HANDOFF_UNVERIFIED" });
  expect(await new PdfTextPreparation({ ...f.deps, journal: new MemoryObjects() }).run({ plan: f.plan, receipt: null }, signal())).toMatchObject({ status: "review", code: "PDF.HANDOFF_PENDING" });
  expect(put.mock.calls.filter(([key]) => key.endsWith(suffix))).toHaveLength(1); expect(f.run).toHaveBeenCalledOnce();
});
it("lost successful publication response is reconciled by GET", async () => {
  const f = await setup(); await f.module.run(f.plan.extraction, signal());
  const create = f.deps.remote.create.bind(f.deps.remote);
  vi.spyOn(f.deps.remote, "create").mockImplementation(async (key, bytes) => { const out = await create(key, bytes); if (key.endsWith("/input.json")) throw Error("lost ack"); return out; });
  expect(await f.prep.run({ plan: f.plan, receipt: null }, signal())).toMatchObject({ status: "prepared" });
});
it("oversized extracted text is rejected, never truncated (synthetic stored engine output)", async () => {
  const f = await setup(), receipt = await f.module.run(f.plan.extraction, signal()); if (receipt.status !== "durable") throw Error();
  const key = pdfCompletionKey(f.plan.extraction), record = JSON.parse(Buffer.from(f.deps.remote.data.get(key)!).toString());
  const bytes = Buffer.from(JSON.stringify({ kind: "text", pageIndex: 1, text: "x".repeat(200001), hasText: true }));
  record.manifest.sha256 = record.artifact.sha256 = sha256(bytes); record.manifest.byteSize = record.artifact.byteSize = bytes.length;
  f.deps.remote.data.set(record.artifact.objectKey, bytes); f.deps.remote.data.set(key, Buffer.from(JSON.stringify(record)));
  expect(await f.prep.run({ plan: f.plan, receipt: null }, signal())).toMatchObject({ status: "review", code: "PDF.TEXT_LIMIT" });
});
it("contracts reject inspection/render, wrong owner and reused operation IDs", async () => {
  const f = await setup();
  for (const plan of [{ ...f.plan, textOperationId: "extract" }, { ...f.plan, textOperationId: "acquisition" },
    { ...f.plan, extraction: { ...f.plan.extraction, module: "pdf.render", scale: 1 } },
    { ...f.plan, extraction: { ...f.plan.extraction, observationId: "foreign" } },
    { ...f.plan, text: { ...f.plan.text, resultSchemaVersion: 1 } }]) expect(PdfTextPlanSchema.safeParse(plan).success).toBe(false);
});
