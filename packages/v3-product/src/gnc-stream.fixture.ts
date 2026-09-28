import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileCopies, ArtifactResolver, verifyBytes } from "@crawl-automation/v3-artifacts";
import { GncLabelInputSchema, TextOutputSchema, TextCandidateV3Schema, type VisionRecord, type LabelCollectedProduct } from "@crawl-automation/v3-contracts";
import { GncAdapter, GncCaptureEvidence, AcquireGncModule, GncProductPlans, GncLabelPlans, ResolveGncReceipt } from "../../v3-channels/src/index.js";
import { AcquireFileModule, FileEvidence, PrepareImageOcr, PageEvidence, PreparePageModule, PreparePageText, PrepareLabelCore, LabelCorePreparation, extractGncLabelCore } from "../../v3-acquisition/src/index.js";
import { lease, response } from "../../v3-acquisition/src/testing.fixture.js";
import { FileCompletionJournal, OcrResultHandoff } from "../../v3-results/src/index.js";
import { MemoryObjects, MemoryRegistry } from "../../v3-results/src/testing.fixture.js";
import { OcrFileModule, OcrIntents, OcrError } from "../../v3-ocr/src/index.js";
import { TextEvidence, TextHandoff, TextModule, ResolveTextReceipt } from "../../v3-text/src/index.js";
import { MemoryTextRegistry } from "../../v3-text/src/testing.fixture.js";
import { labelExecutionFixture } from "../../v3-text/src/label-execution.fixture.js";
import { RegisteredOcrEvidence, visionReviewWriter, KeywordPublication, VisionHandoff, VisionModule } from "../../v3-vision/src/index.js";
import { gncLabelFixture } from "../../v3-contracts/src/label.fixture.js";
import { SavedSourceEvidence } from "./saved-sources.js";
import { ResolveOcrReceipt } from "./ocr-receipt.js";
import { LabelProductAssembly, CollectLabelProduct } from "./label-product.js";
import { PackagingEvidence } from "./packaging.js";
/** Real atomic classes, isolated stores; network/model providers are synthetic. No live service access. */
export async function gncStreamFixture(coreEnabled = false, variantId?: string) {
  const root = await mkdtemp(join(tmpdir(), "gnc-stream-fixture-")), base = labelExecutionFixture();
  if (coreEnabled) base.owner.sourceId = "gnc";
  if (variantId) base.owner.variantId = variantId;
  const local = new MemoryObjects(), remote = new MemoryObjects(), reviews = base.reviews, counts = { capture: 0, download: 0, ocr: 0, text: 0, vision: 0 };
  const input = GncLabelInputSchema.parse({ operationId: "stream-label-product", text: base.supported, visionConfigFingerprint: "e".repeat(64), ...(coreEnabled ? { corePolicy: "gnc-label-core/1" } : {}), sourcePlan: {
    operationId: "source-plan", task: { schemaVersion: 1, implementationVersion: "gnc-acquire/1", owner: base.owner,
      capture: { kind: "product", requestId: base.owner.requestId, operationId: "capture", brandId: base.owner.brandId, sourceId: base.owner.sourceId,
        url: "https://www.gnc.com/123456.html", sku: "123456", binding: { sessionId: "session-1", egressId: "direct/1" } },
      network: { routeId: "fixture", version: "1", mode: "direct", managed: true, egressId: "direct/1" } },
    text: { ...base.supported, implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2 },
    ocr: { schemaVersion: 1, module: "ocr.file", implementationVersion: "1", policyVersion: "1", resultSchemaVersion: 2, configFingerprint: "b".repeat(64) }, visionConfigFingerprint: "c".repeat(64) } });
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Preserve fixture line numbers: wrapping every line in <p> would add blank lines.
  const [formulaText, otherText] = base.text.split("Other Ingredients\n");
  const fragment = `<div class="product-nutrition-description"><table><tr><td>${escape(formulaText!.replace(/^2\n3\n/, "Serving Size\n2\nServings Per Container\n3\n"))}</td></tr></table><div class="pdp-details-accordion__section"><h4>Other Ingredients</h4><div class="pdp-details-accordion__section-content">${escape(otherText!)}</div></div><div>Servings Per Container\n12</div></div>`;
  const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", sku: "123456", name: "Synthetic Label", image: ["https://www.gnc.com/back.png", "https://www.gnc.com/front.png"] })}</script><div id="productIngredientsAccordionContent">${coreEnabled ? fragment : escape(base.text)}</div>`;
  const wire = structuredClone(base.wire);
  if (coreEnabled) {
    const coreText = extractGncLabelCore(fragment); let cursor = 0;
    const anchor = (v: any) => { if (!v || typeof v !== "object") return;
      if ("fromLine" in v) { const start = coreText.indexOf(v.text, cursor); if (start < 0) throw Error("Fixture quote missing"); cursor = start + v.text.length;
        v.fromLine = coreText.slice(0, start).split("\n").length; v.toLine = coreText.slice(0, cursor).split("\n").length;
      } else Object.values(v).forEach(anchor);
    }; anchor(wire);
    for (const text of ["Serving Size", "Servings Per Container"]) {
      const line = coreText.slice(0, coreText.indexOf(text)).split("\n").length;
      wire.exclusions.push({ reason: "heading", quote: { text, fromLine: line, toLine: line } });
    }
  }
  const captureEvidence = new GncCaptureEvidence({ local, remote, reviews });
  const capture = new AcquireGncModule(captureEvidence, new GncAdapter({ read: async task => { counts.capture++; return {
    operationId: task.operationId, requestedUrl: task.url, finalUrl: task.url, status: 200, contentType: "text/html", bytes: Buffer.from(html), binding: task.binding, network: input.sourcePlan.task.network }; } }));
  const plans = new GncProductPlans(captureEvidence), captureReceipt = new ResolveGncReceipt(captureEvidence);
  const copies = await FileCopies.open(join(root, "cache")), artifacts = new ArtifactResolver(copies, remote);
  const fileEvidence = new FileEvidence({ local, remote, reviews, copies });
  const files = new AcquireFileModule(fileEvidence, { dns: { resolve: async () => [{ address: "93.184.216.34", family: 4 }] }, access: { acquire: async task => ({
    ...lease(async () => { counts.download++; return response(); }), owner: base.owner, sourceId: task.sourceId, resourceId: task.resourceId, binding: task.binding }) } });
  const pages = new PageEvidence({ local, remote, reviews }), pagePrepare = new PreparePageModule(pages), pageText = new PreparePageText(pages), imagePrepare = new PrepareImageOcr(fileEvidence);
  const ocrRegistry = new MemoryRegistry(), ocrResults = new OcrResultHandoff("fixture-r2/1", copies, remote, await FileCompletionJournal.open(join(root, "ocr-journal")), ocrRegistry);
  const nonmatch = new Set<string>(), emptyOcr = new Set<string>();
  const ocr = new OcrFileModule({ provider: { provider: "fixture/1", supported: input.sourcePlan.ocr, close: async () => {}, recognize: async file => {
    counts.ocr++; if(emptyOcr.has(file.artifactId))throw new OcrError("OCR.EMPTY","executed");
    return { text: nonmatch.has(file.artifactId) ? "Marketing only" : "Supplement Facts", lines: [] }; } },
    artifacts, intents: new OcrIntents(remote, "stream-ocr", "fixture-r2/1"), results: ocrResults, reviews });
  const ocrReceipt = new ResolveOcrReceipt({ results: ocrResults, local, reviews }), screen = new RegisteredOcrEvidence(artifacts, ocrResults, ocrRegistry), keywords = new KeywordPublication(local, remote);
  const textEvidence = new TextEvidence(artifacts, ocrResults), textRegistry = new MemoryTextRegistry(), textHandoff = new TextHandoff(local, remote, textRegistry, textEvidence, "fixture-r2/1");
  const text = new TextModule({ provider: { ...base.provider, supported: input.text, interpret: async () => { counts.text++; return JSON.stringify(wire); } }, handoff: textHandoff, reviews, nodeId: "stream-text" });
  const textReceipt = new ResolveTextReceipt({ results: textHandoff, local, reviews }), visionRecords = new Map<string, VisionRecord>();
  const visionHandoff = new VisionHandoff(local, remote, { read: async id => visionRecords.get(id) ?? null, register: async r => { visionRecords.set(r.input.operationId, r); } }, "fixture-r2/1",
    async (task, abort) => { await screen.verifiedText(task.input.selection, abort); });
  const imageCandidate={value:gncLabelFixture()};
  const vision = new VisionModule({ provider: { fingerprint: input.visionConfigFingerprint, extractionProtocol: "label-extraction/1", interpret: async () => { counts.vision++; return JSON.stringify(imageCandidate.value); } },
    store: remote, localEvidence: local, verifiedOcrText: (selected, abort) => screen.verifiedText(selected, abort), resolve: async (file, abort, owner) => (await artifacts.resolve(file, owner, abort)).bytes });
  const saved = new SavedSourceEvidence({ remote, files: fileEvidence, pages, reviews, ocr: ocrRegistry, screen });
  const core = new PrepareLabelCore(artifacts, new LabelCorePreparation(artifacts, remote)), packaging = new PackagingEvidence(artifacts);
  const labelPlans = new GncLabelPlans(captureEvidence, (source, abort) => saved.resolve(source, { id: source.id, status: "unresolved" }, abort), (input, abort) => core.inspect(input, abort));
  const assembly = new LabelProductAssembly({ local, remote, reviews, readPackaging: (m, abort) => packaging.inspect(m.observation, m.admission!.documents, abort), readSource: async (source, abort) => {
    if (source.kind === "image") return { id: source.id, kind: "image", ...await visionHandoff.readLabelCandidate(source.task, abort) };
    const facts = await textHandoff.inspect(source.task, abort);
    if (!facts.artifactDurable || !facts.resultRegistered || !facts.record) throw Error("unverified");
    const bytes = await remote.read(facts.record.result.objectKey, 524288); if (!bytes) throw Error("missing"); verifyBytes(facts.record.result, bytes, 524288);
    return { id: source.id, kind: "text", record: facts.record, candidate: TextCandidateV3Schema.parse(TextOutputSchema.parse(JSON.parse(Buffer.from(bytes).toString())).candidate), fullText: (await textEvidence.resolve(source.task, abort)).text };
  } });
  const collected = new Map<string, LabelCollectedProduct>(), collector = new CollectLabelProduct({ local, remote, reviews, assembly,
    registry: { read: async id => collected.get(id) ?? null, append: async record => { collected.set(record.operationId, record); } } });
  const signal = () => AbortSignal.timeout(15000);
  const activities: Record<string, (raw: any) => Promise<any>> = {
    prepareLabelCore: raw => core.run(raw, signal()),
    captureGncProduct: raw => capture.run(raw, signal()), resolveGncReceipt: raw => captureReceipt.run(raw, signal()), prepareGncProduct: raw => plans.run(raw, signal()),
    loadGncLabelPlan: async raw => { const out = await labelPlans.load(raw, signal()); const s = out.manifest.sources.find(s => s.id === "image-1"); if (s?.kind === "file-image") nonmatch.add(s.plan.imageId); return out; },
    prepareHtmlPage: raw => pagePrepare.run(raw, signal()), preparePageText: raw => pageText.run(raw, signal()), acquireSourceFile: raw => files.run(raw, signal()),
    prepareImageOcr: raw => imagePrepare.run(raw, signal()), ocrFile: raw => ocr.run(raw, signal()), resolveOcrReceipt: raw => ocrReceipt.run(raw, signal()),
    screenImageKeywords: async raw => { const r = await screen.screen(raw, signal()); return { status: r.status, imageId: r.image.artifactId, selection: r, ...await keywords.publish(r, signal()) }; },
    prepareGncLabelSource: raw => labelPlans.source(raw, signal()), prepareGncLabel: raw => labelPlans.run(raw, signal()),
    interpretText: raw => text.run(raw, signal()), resolveTextReceipt: raw => textReceipt.run(raw, signal()),
    interpretImage: async raw => { if (!await visionHandoff.inspect(raw, signal())) {
      const out = await vision.run(raw.input, signal()); if (out.status === "review") return {status:"review",code:out.code,...await visionReviewWriter(local,reviews)(raw,out,signal())}; await visionHandoff.complete(raw, signal());
    } return { status: "registered", operationId: raw.input.operationId }; },
    assembleLabelProduct: raw => assembly.run(raw, signal()), collectLabelProduct: raw => collector.run(raw, signal()),
  };
  const route = { capture: "captureGncProduct", captureReceipts: "resolveGncReceipt", productPlan: "prepareGncProduct", plan: "loadGncLabelPlan", source: "prepareGncLabelSource", manifest: "prepareGncLabel",
    page: "prepareHtmlPage", pageText: "preparePageText", acquire: "acquireSourceFile", imagePrepare: "prepareImageOcr", ocr: "ocrFile", ocrReceipts: "resolveOcrReceipt", keywords: "screenImageKeywords",
    text: "interpretText", textReceipts: "resolveTextReceipt", vision: "interpretImage", assembly: "assembleLabelProduct", collection: "collectLabelProduct" };
  const routed = { ...route, ...(coreEnabled ? { core: "prepareLabelCore" } : {}) };
  return { input, activities, route: routed, queues: Object.fromEntries(Object.keys(routed).map(k => [k, k])), counts, collected, reviews, remote, local, labelPlans, fileEvidence, plans, textRegistry, visionRecords, visionHandoff, nonmatch, emptyOcr, imageCandidate, saved };
}
