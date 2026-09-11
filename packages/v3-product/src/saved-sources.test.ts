import { expect, it } from "vitest";
import { PageEvidence, PreparePageModule, PreparePageText } from "../../v3-acquisition/src/page-handoff.js";
import { pageInput } from "../../v3-acquisition/src/testing.fixture.js";
import { MemoryObjects, setup as ocrSetup, signal } from "../../v3-results/src/testing.fixture.js";
import { MemoryTextReviews } from "../../v3-text/src/testing.fixture.js";
import { ArtifactResolver } from "@crawl-automation/v3-artifacts";
import { RegisteredOcrEvidence, KeywordPublication, keywordKey } from "@crawl-automation/v3-vision";
import { ProductEvidenceManifestSchema, observationIdentity, type SavedEvidenceSource } from "@crawl-automation/v3-contracts";
import { SavedSourceEvidence } from "./saved-sources.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileCopies } from "@crawl-automation/v3-artifacts";
import { PdfModule, PdfEvidence, PdfTextEvidence, PdfTextPreparation, PdfSubprocess } from "../../v3-pdf/src/index.js";
import { inputFor, nutritionPdf } from "../../v3-pdf/integration/helpers.js";
import { SavedProductWorkflowInputSchema } from "@crawl-automation/v3-contracts";
async function page(html = "<p>Other ingredients: Water</p>") {
  const f = pageInput(html), local = new MemoryObjects(), remote = new MemoryObjects(), reviews = new MemoryTextReviews();
  remote.data.set(f.input.page.objectKey, f.bytes);
  const evidence = new PageEvidence({ local, remote, reviews });
  const source: Extract<SavedEvidenceSource, { kind: "page" }> = { id: "page", kind: "page", required: true,
    plan: { page: f.input, textOperationId: "text-operation", text: { schemaVersion: 1, module: "codex.text", implementationVersion: "codex-text/2",
      policyVersion: "anchored/2", resultSchemaVersion: 2, configFingerprint: "b".repeat(64) } } };
  const receipt = await new PreparePageModule(evidence).run(f.input, signal());
  const prepared = await new PreparePageText(evidence).run({ plan: source.plan, receipt }, signal());
  const resolver = new SavedSourceEvidence({ remote, pages: evidence, reviews, ocr: { read: async () => null }, screen: { screen: async () => { throw Error(); } } });
  return { ...f, local, remote, reviews, source, prepared, resolver };
}
it("saved page resolves only exact published full-text task, without parsing or PUT", async () => {
  const f = await page(), before = f.remote.writes;
  if (f.prepared.status !== "prepared") throw Error();
  expect(await f.resolver.resolve(f.source, { id: "page", status: "registered" }, signal())).toEqual({ status: "resolved", source: {
    id: "page", kind: "text", required: true, task: f.prepared.task } });
  expect(await f.resolver.resolve(f.source, { id: "page", status: "unresolved" }, signal())).toMatchObject({ status: "resolved" });
  expect(f.remote.writes).toBe(before);
});
it.each(["source", "task", "tables"])("saved page %s corruption cannot turn into verified preparation", async kind => {
  const f = await page();
  const key = kind === "source" ? f.input.page.objectKey : kind === "task" ? `v3/page-text-inputs/${f.source.plan.textOperationId}.json` : `v3/pages/${f.input.operationId}/tables.json`;
  f.remote.data.set(key, Buffer.from("{}"));
  expect(await f.resolver.resolve(f.source, { id: "page", status: "registered" }, signal())).toMatchObject({ status: "review", code: "SAVED.PREPARATION_UNVERIFIED" });
});
it("explicit page failure stays failure even if optional; forged review is rejected", async () => {
  const f = await page("<script>nothing</script>"); if (f.prepared.status !== "review") throw Error();
  f.source.required = false;
  const state = { id: "page", status: "review" as const, reviewId: f.prepared.reviewId };
  expect(await f.resolver.resolve(f.source, state, signal())).toEqual({ status: "review", code: "PROCESSING.PAGE_EMPTY" });
  f.reviews.records.get(state.reviewId)!.failure.inputFingerprint = "c".repeat(64);
  await expect(f.resolver.resolve(f.source, state, signal())).rejects.toThrow("SAVED.IDENTITY_CONFLICT");
  await expect(f.resolver.resolve(f.source, { ...state, reviewId: "missing" }, signal())).rejects.toThrow("SAVED.REVIEW_UNVERIFIED");
});
it("saved source contract rejects cross-product and duplicate stage operation identities", async () => {
  const f = await page(), manifest = { operationId: "product", observation: observationIdentity(f.input), sources: [f.source] };
  expect(ProductEvidenceManifestSchema.safeParse(manifest).success).toBe(true);
  expect(ProductEvidenceManifestSchema.safeParse({ ...manifest, observation: { ...manifest.observation, variantId: "other" } }).success).toBe(false);
  expect(ProductEvidenceManifestSchema.safeParse({ ...manifest, sources: [f.source, { ...f.source, id: "duplicate" }] }).success).toBe(false);
  await expect(f.resolver.resolve(f.source, { id: "page", status: "not_matched" }, signal())).rejects.toThrow("SAVED.RECEIPT_INVALID");
});
async function image(text: string) {
  const f = await ocrSetup(); f.output.text = text;
  await f.handoff.capture(f.input, f.output, signal()); await f.handoff.uploadMissing(f.input, signal()); await f.handoff.register(f.input, signal());
  const record = (await f.registry.read(f.input.operationId))!;
  const screen = new RegisteredOcrEvidence(new ArtifactResolver(f.local, f.remote), f.handoff, f.registry), selection = await screen.screen(record, signal());
  const local = new MemoryObjects(); await new KeywordPublication(local, f.remote).publish(selection, signal());
  const resolver = new SavedSourceEvidence({ remote: f.remote, pages: { inspect: async () => null }, ocr: f.registry, screen, reviews: new MemoryTextReviews() });
  const source: SavedEvidenceSource = { id: "label", kind: "ocr-image", required: true, task: f.input, visionOperationId: "vision-operation", configFingerprint: "a".repeat(64) };
  return { ...f, selection, source, resolver };
}
it("unmatched image needs verified OCR and retained keyword decision; false success is rejected", async () => {
  const f = await image("Marketing only"), before = f.remote.writes;
  expect(await f.resolver.resolve(f.source, { id: "label", status: "not_matched" }, signal())).toEqual({ status: "not_matched" });
  expect(f.remote.writes).toBe(before);
  await expect(f.resolver.resolve(f.source, { id: "label", status: "registered" }, signal())).rejects.toThrow("SAVED.RECEIPT_INVALID");
  f.remote.data.delete(keywordKey(f.selection));
  expect(await f.resolver.resolve(f.source, { id: "label", status: "not_matched" }, signal())).toMatchObject({ status: "review" });
});
it("matched image resolves pinned vision task; cannot be falsely skipped", async () => {
  const f = await image("Supplement Facts");
  expect(await f.resolver.resolve(f.source, { id: "label", status: "unresolved" }, signal())).toMatchObject({ status: "resolved",
    source: { kind: "image", task: { input: { operationId: "vision-operation", selection: f.selection } } } });
  await expect(f.resolver.resolve(f.source, { id: "label", status: "not_matched" }, signal())).rejects.toThrow("SAVED.RECEIPT_INVALID");
});
async function pdf(empty = false) {
  const root = await mkdtemp(join(tmpdir(), "v3-saved-pdf-")), bytes = nutritionPdf(1, empty ? "" : undefined), extraction = inputFor(bytes, "pdf.text", "extract-pdf");
  if (extraction.module !== "pdf.text") throw Error("Wrong fixture capability");
  const remote = new MemoryObjects(), journal = new MemoryObjects(), reviews = new MemoryTextReviews(); remote.data.set(extraction.pdf.objectKey, bytes);
  const deps = { remote, journal, reviews, copies: await FileCopies.open(join(root, "cache")) };
  const source: Extract<SavedEvidenceSource, { kind: "pdf-text" }> = { id: "pdf-page", kind: "pdf-text", required: true,
    plan: { extraction, textOperationId: "pdf-interpret", text: { schemaVersion: 1, module: "codex.text", implementationVersion: "codex-text/2",
      policyVersion: "anchored/2", resultSchemaVersion: 2, configFingerprint: "b".repeat(64) } } };
  const engine = await PdfSubprocess.open({ pythonExecutable: resolve("../v3-pdf/.venv/bin/python"), workRoot: join(root, "attempts") });
  const receipt = await new PdfModule(deps, engine).run(extraction, signal());
  const prepared = await new PdfTextPreparation(deps).run({ plan: source.plan, receipt }, signal());
  const resolver = new SavedSourceEvidence({ remote, reviews, pages: { inspect: async () => null }, ocr: { read: async () => null },
    screen: { screen: async () => { throw Error("not an image"); } }, pdfText: new PdfTextEvidence(remote, new PdfEvidence(deps)) });
  return { source, prepared, resolver, deps };
}
it("saved PDF page resolves exactly the prepared task; false nonmatch is rejected and damaged input never re-prepares", async () => {
  const f = await pdf(), writes = f.deps.remote.writes; if (f.prepared.status !== "prepared") throw Error();
  for (const status of ["registered", "unresolved"] as const)
    expect(await f.resolver.resolve(f.source, { id: f.source.id, status }, signal())).toEqual({ status: "resolved",
      source: { id: f.source.id, kind: "text", required: true, task: f.prepared.task } });
  await expect(f.resolver.resolve(f.source, { id: f.source.id, status: "not_matched" }, signal())).rejects.toThrow("SAVED.RECEIPT_INVALID");
  f.deps.remote.data.delete(f.prepared.evidenceKey);
  expect(await f.resolver.resolve(f.source, { id: f.source.id, status: "registered" }, signal())).toEqual({ status: "review", code: "SAVED.PREPARATION_UNVERIFIED" });
  expect(f.deps.remote.writes).toBe(writes);
});
it("PDF preparation Review binds its full downstream plan; an optional source cannot borrow another task's failure", async () => {
  const f = await pdf(true); if (f.prepared.status !== "review") throw Error();
  const state = { id: f.source.id, status: "review" as const, reviewId: f.prepared.reviewId }; f.source.required = false;
  expect(await f.resolver.resolve(f.source, state, signal())).toEqual({ status: "review", code: "PDF.TEXT_EMPTY" });
  const changed = { ...f.source, plan: { ...f.source.plan, textOperationId: "another-model-operation" } };
  await expect(f.resolver.resolve(changed, state, signal())).rejects.toThrow("SAVED.IDENTITY_CONFLICT");
  f.deps.reviews.records.get(state.reviewId)!.failure.inputFingerprint = "c".repeat(64);
  await expect(f.resolver.resolve(f.source, state, signal())).rejects.toThrow("SAVED.IDENTITY_CONFLICT");
});
it("saved PDF contract requires queues, matching observation and distinct stage operation identities", async () => {
  const f = await pdf(), manifest = { operationId: "product", observation: observationIdentity(f.source.plan.extraction), sources: [f.source] };
  const queues = { page: "p", pageText: "pt", text: "t", textReceipts: "tr", ocr: "o", ocrReceipts: "or", keywords: "k", vision: "v", assembly: "a", collection: "c" };
  expect(SavedProductWorkflowInputSchema.safeParse({ manifest, queues }).success).toBe(false);
  expect(SavedProductWorkflowInputSchema.safeParse({ manifest, queues: { ...queues, pdfText: "pdf", pdfTextPrepare: "pdfp" } }).success).toBe(true);
  for (const value of [ { ...manifest, observation: { ...manifest.observation, brandId: "foreign" } },
    { ...manifest, sources: [f.source, { ...f.source, id: "duplicate" }] },
    { ...manifest, operationId: f.source.plan.textOperationId } ]) expect(ProductEvidenceManifestSchema.safeParse(value).success).toBe(false);
});
