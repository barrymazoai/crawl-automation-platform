import { expect, it, vi } from "vitest";
import { GncProductInputSchema, SavedProductWorkflowInputSchema, type GncProductInput, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { type ObjectStore } from "@crawl-automation/v3-artifacts";
import { preparePage, createHttpRoute, acquireFile } from "@crawl-automation/v3-acquisition";
import { png } from "../../v3-acquisition/src/testing.fixture.js";
import { GncFileSources } from "./gnc-files.js";
import { prepareGncFileGrant } from "./gnc-file-grant.js";
import { GncAdapter } from "./gnc.js";
import { AcquireGncModule, GncCaptureEvidence } from "./gnc-handoff.js";
import { GncProductPlans, gncProductKey } from "./gnc-product.js";
import { GncLabelPlans, gncLabelKey } from "./gnc-label.js";
import { PageEvidence, PreparePageModule, PreparePageText } from "@crawl-automation/v3-acquisition";
import { SavedSourceEvidence } from "../../v3-product/src/saved-sources.js";
import { GncLabelInputSchema, LabelProductWorkflowInputSchema } from "@crawl-automation/v3-contracts";
import { screenKeywords } from "../../v3-vision/src/keywords.js";
class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
  read = vi.fn(async (key: string, max: number) => { const b = this.data.get(key); if (b && b.length > max) throw Error("limit"); return b ?? null; });
  create = vi.fn(async (key: string, b: Uint8Array) => { if (this.data.has(key)) return "exists" as const; this.data.set(key, Buffer.from(b)); return "created" as const; });
}
const signal = () => new AbortController().signal;
const rawInput: GncProductInput = { operationId: "product", task: { schemaVersion: 1, implementationVersion: "gnc-acquire/1",
  owner: { schemaVersion: 1, requestId: "req", observationId: "obs", brandId: "brand", sourceId: "source", listingId: "sku-123456", variantId: null },
  capture: { kind: "product", requestId: "req", operationId: "capture", brandId: "brand", sourceId: "source", url: "https://www.gnc.com/123456.html", sku: "123456", binding: { sessionId: "s", egressId: "direct/1" } },
  network: { routeId: "route", version: "1", egressId: "direct/1", mode: "direct", managed: true } },
  text: { schemaVersion: 1, module: "codex.text", implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2, configFingerprint: "a".repeat(64) },
  ocr: { schemaVersion: 1, module: "ocr.file", implementationVersion: "1", policyVersion: "1", resultSchemaVersion: 2, configFingerprint: "b".repeat(64) }, visionConfigFingerprint: "c".repeat(64) };
async function fixture(options: { page?: boolean; images?: number; invalid?: boolean; proxy?: boolean; legacyGallery?: boolean } = {}) {
  const input = GncProductInputSchema.parse(rawInput), local = new Memory(), remote = new Memory(), rows = new Map<string, ReviewRecord>();
  if (options.proxy) { input.task.network = { mode: "static-proxy", managed: true, routeId: "proxy", version: "1", egressId: "proxy/1" }; input.task.capture.binding.egressId = "proxy/1"; }
  const reviews = { read: async (id: string) => rows.get(id) ?? null, append: async (r: ReviewRecord) => { if (!rows.has(r.reviewId)) rows.set(r.reviewId, structuredClone(r)); } };
  const data = { "@type": "Product", sku: "123456", name: "Test", image: Array.from({ length: options.images ?? 2 }, (_, i) => `https://www.gnc.com/label-${i}.png`) };
  const html = `<script type="application/ld+json">${JSON.stringify(data)}</script>${options.page === false ? "" : '<div id="productIngredientsAccordionContent">Other ingredients: Water</div>'}<div class="recommendation">Unrelated product 999 mg</div>${options.legacyGallery ? '<div class="product-thumbnails-grid"><img alt="Test | GNC" data-zoom-url="https://www.gnc.com/back.png"></div>' : ''}`;
  const read = vi.fn(async () => ({ operationId: input.task.capture.operationId, requestedUrl: input.task.capture.url, finalUrl: input.task.capture.url,
    binding: input.task.capture.binding, status: 200, contentType: "text/html", bytes: Buffer.from(html), network: input.task.network }));
  const evidence = new GncCaptureEvidence({ local, remote, reviews });
  const adapter = new GncAdapter({ read });
  if (options.legacyGallery) {
    const capture = adapter.capture.bind(adapter);
    // Simulate the previously published parser result, while retaining the complete original HTML.
    vi.spyOn(adapter, "capture").mockImplementation(async (...args) => {
      const r = await capture(...args);
      if ("imageCandidates" in r.data) r.data.imageCandidates = r.data.imageCandidates.slice(0, options.images ?? 2);
      return r;
    });
  }
  const receipt = await new AcquireGncModule(evidence, adapter).run(input.task, signal());
  expect(receipt.status).toBe("durable");
  return { input, local, remote, reviews, rows, read, receipt, plans: new GncProductPlans(evidence), evidence };
}
async function labelFixture(images = 0) {
  const f = await fixture({ images }); await f.plans.run({ input: f.input, receipt: null }, signal());
  const plan = (await f.plans.inspect(f.input, signal()))!, source = plan.manifest.sources[0]!;
  if (source.kind !== "page") throw Error();
  const pages = new PageEvidence(f.evidence.deps), prepared = await new PreparePageModule(pages).run(source.plan.page, signal());
  await new PreparePageText(pages).run({ plan: source.plan, receipt: prepared }, signal());
  const saved = new SavedSourceEvidence({ remote: f.remote, pages, reviews: f.reviews, ocr: { read: async () => null }, screen: { screen: async () => { throw Error(); } } });
  const resolve = vi.fn((s: Parameters<typeof saved.resolve>[0], abort: AbortSignal) => saved.resolve(s, { id: s.id, status: "unresolved" }, abort));
  const input = GncLabelInputSchema.parse({ operationId: "new-label-product", sourcePlan: f.input,
    text: { ...f.input.text, implementationVersion: "codex-text/3", policyVersion: "label-text/1", resultSchemaVersion: 3, configFingerprint: "f".repeat(64) }, visionConfigFingerprint: "e".repeat(64) });
  return { ...f, labelInput: input, resolve, planner: new GncLabelPlans(f.evidence, resolve) };
}
it("streaming plan does not wait for preparation; one page can be published while both images are unprepared", async () => {
  const f = await labelFixture(2), puts = f.remote.create.mock.calls.length;
  expect((await f.planner.load(f.labelInput, signal())).manifest.sources).toHaveLength(3);
  expect(f.resolve).not.toHaveBeenCalled(); expect(f.remote.create).toHaveBeenCalledTimes(puts);
  const request = { input: f.labelInput, sourceId: "page" }, out = await f.planner.source(request, signal());
  expect(out).toMatchObject({ status: "prepared", source: { id: "page", kind: "text", required: true, task: { resultSchemaVersion: 3 } } });
  expect(f.resolve.mock.calls.map(c => c[0].id)).toEqual(["page"]);
  const writes = f.remote.create.mock.calls.length;
  const cold = new GncLabelPlans(new GncCaptureEvidence({ ...f.evidence.deps, local: new Memory() }), f.resolve);
  expect(await cold.source(request, signal())).toEqual(out); expect(f.remote.create).toHaveBeenCalledTimes(writes);
  expect(f.remote.data.has(gncLabelKey(f.labelInput))).toBe(false);
});
it("single-source preparation rejects a foreign source and missing image evidence without treating it as a nonmatch", async () => {
  const f = await labelFixture(2), puts = f.remote.create.mock.calls.length;
  await expect(f.planner.source({ input: f.labelInput, sourceId: "foreign" }, signal())).rejects.toThrow();
  expect(f.resolve).not.toHaveBeenCalled();
  await expect(f.planner.source({ input: f.labelInput, sourceId: "image-0" }, signal())).rejects.toThrow();
  expect(f.remote.create).toHaveBeenCalledTimes(puts);
});
it.each([true, false])("single-source unknown publication (stored=%s) never retries PUT even with a cold worker", async stored => {
  const f = await labelFixture(), key = `v3/gnc-label-inputs/${f.labelInput.operationId}/sources/page.json`, create = f.remote.create.getMockImplementation()!;
  f.remote.create.mockImplementation(async (...args) => { if (args[0] !== key) return create(...args); if (stored) await create(...args); throw Error("lost"); });
  const request = { input: f.labelInput, sourceId: "page" };
  const first = f.planner.source(request, signal());
  if (stored) expect(await first).toMatchObject({ status: "prepared" }); else await expect(first).rejects.toThrow();
  const cold = new GncLabelPlans(new GncCaptureEvidence({ ...f.evidence.deps, local: new Memory() }), f.resolve);
  const again = cold.source(request, signal());
  if (stored) expect(await again).toMatchObject({ status: "prepared" }); else await expect(again).rejects.toThrow();
  expect(f.remote.create.mock.calls.filter(c => c[0] === key)).toHaveLength(1);
});
it("new label manifest reuses verified page preparation, preserves old objects, and cold reuse does not PUT", async () => {
  const f = await labelFixture(), before = new Map(f.remote.data), out = await f.planner.run(f.labelInput, signal());
  expect(out.status).toBe("prepared"); if (out.status !== "prepared") throw Error();
  expect(out.manifest.sources[0]).toMatchObject({ kind: "text", required: true, task: { resultSchemaVersion: 3 } });
  expect(out.skipped).toEqual([]); expect(out.manifest.operationId).toBe(f.labelInput.operationId);
  expect(LabelProductWorkflowInputSchema.safeParse({ manifest: out.manifest, queues: { text: "t", textReceipts: "r", vision: "v", assembly: "a", collection: "c" } }).success).toBe(true);
  for (const [key, bytes] of before) expect(f.remote.data.get(key)).toEqual(bytes);
  const puts = f.remote.create.mock.calls.length;
  expect(await new GncLabelPlans(new GncCaptureEvidence({ ...f.evidence.deps, local: new Memory() }), f.resolve).run(f.labelInput, signal())).toEqual(out);
  expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.read).toHaveBeenCalledTimes(1);
});
it.each(["missing", "foreign", "not_matched"])("label compiler does not silently skip %s page evidence", async kind => {
  const f = await labelFixture(), original = f.resolve.getMockImplementation()!;
  f.resolve.mockImplementation(async (...args) => {
    if (kind === "missing") return { status: "review", code: "SAVED.PREPARATION_UNVERIFIED" };
    if (kind === "not_matched") return { status: "not_matched" };
    const r = await original(...args); if (r.status === "resolved") r.source.id = "foreign"; return r;
  });
  expect(await f.planner.run(f.labelInput, signal())).toMatchObject({ status: "review", automaticRetry: false });
  expect(f.remote.data.has(gncLabelKey(f.labelInput))).toBe(false);
  const calls = f.resolve.mock.calls.length;
  expect((await f.planner.run(f.labelInput, signal())).status).toBe("review"); expect(f.resolve).toHaveBeenCalledTimes(calls);
});
it.each([true, false])("label manifest unknown publication (stored=%s) never retries the data PUT", async stored => {
  const f = await labelFixture(), create = f.remote.create.getMockImplementation()!, key = gncLabelKey(f.labelInput);
  f.remote.create.mockImplementation(async (...args) => { if (args[0] !== key) return create(...args); if (stored) await create(...args); throw Error("lost"); });
  const result = await f.planner.run(f.labelInput, signal()); expect(result.status).toBe(stored ? "prepared" : "review");
  expect(await new GncLabelPlans(new GncCaptureEvidence({ ...f.evidence.deps, local: new Memory() }), f.resolve).run(f.labelInput, signal())).toEqual(result);
  expect(f.remote.create.mock.calls.filter(c => c[0] === key)).toHaveLength(1);
});
it("label manifest settings cannot change within one product operation", async () => {
  const f = await labelFixture(); await f.planner.run(f.labelInput, signal()); const puts = f.remote.create.mock.calls.length;
  expect(await f.planner.run({ ...f.labelInput, visionConfigFingerprint: "d".repeat(64) }, signal())).toMatchObject({ status: "review", code: "GNC.LABEL_PLAN_CONFLICT" });
  expect(f.remote.create).toHaveBeenCalledTimes(puts);
});
it("image-first policy is retained in the manifest and cannot be applied over an old operation", async () => {
  const f = await labelFixture();
  const input = { ...f.labelInput, evidencePolicy: "label-image-first/1" as const };
  const out = await f.planner.run(input, signal());
  expect(out).toMatchObject({ status: "prepared", manifest: { evidencePolicy: "label-image-first/1" } });
  expect(await f.planner.run(f.labelInput, signal())).toMatchObject({ status: "review", code: "GNC.LABEL_PLAN_CONFLICT" });
});
it("cancelled label preparation neither publishes nor writes Review", async () => {
  const f = await labelFixture(), puts = f.remote.create.mock.calls.length;
  await expect(f.planner.run(f.labelInput, AbortSignal.abort(Error("cancelled")))).rejects.toThrow("cancelled");
  expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.rows.size).toBe(0);
});
it.each([false, true])("label compiler covers every image and rejects a foreign selected image (foreign=%s)", async foreign => {
  const f = await labelFixture(2), original = f.resolve.getMockImplementation()!;
  const plan = (await f.plans.inspect(f.input, signal()))!;
  f.resolve.mockImplementation(async (source, abort) => {
    if (source.kind !== "file-image") return original(source, abort);
    if (source.id === "image-0") return { status: "not_matched" };
    const image = { ...plan.fragment!, artifactId: foreign ? "foreign-image" : source.plan.imageId, kind: "source-image" as const,
      mediaType: "image/png", objectKey: "images/selected.png", producer: { operationId: source.plan.acquire.operationId, module: "file.acquire", implementationVersion: "1" } };
    return { status: "resolved", source: { id: source.id, kind: "image", required: source.required,
      task: { configFingerprint: source.configFingerprint, input: { operationId: source.visionOperationId,
        selection: screenKeywords({ observation: f.input.task.owner, image, ocrOperationId: source.plan.ocrOperationId, text: "Supplement Facts" }) } } } };
  });
  const out = await f.planner.run(f.labelInput, signal());
  expect(out.status).toBe(foreign ? "review" : "prepared");
  if (out.status === "prepared") {
    expect(out.skipped).toEqual(["image-0"]); expect(out.manifest.sources.map(s => s.id)).toEqual(["page", "image-1"]);
    expect(out.manifest.sources[1]).toMatchObject({ required: true, task: { configFingerprint: f.labelInput.visionConfigFingerprint, input: { extractionProtocol: "label-extraction/1" } } });
  }
  expect(new Set(f.resolve.mock.calls.map(c => c[0].id))).toEqual(new Set(["page", "image-0", "image-1"]));
});
it("plans complete URL-free file tasks and a SKU-scoped page consumable by the existing parser", async () => {
  const f = await fixture(), out = await f.plans.run({ input: f.input, receipt: f.receipt }, signal());
  expect(out.status).toBe("prepared"); if (out.status !== "prepared") throw Error();
  expect(out.manifest.sources.map(s => s.kind)).toEqual(["page", "file-image", "file-image"]);
  expect(out.manifest.sources.every(s => !s.required)).toBe(true);
  expect(JSON.stringify(out.manifest)).not.toContain("https://");
  const source = out.manifest.sources[0]!; if (source.kind !== "page") throw Error();
  const html = f.remote.data.get(source.plan.page.page.objectKey)!;
  expect(preparePage(source.plan.page, html, signal()).text).toBe("Other ingredients: Water");
  expect(Buffer.from(html).toString()).not.toContain("Unrelated product");
  expect(f.read).toHaveBeenCalledTimes(1);
});
it("explicit v2 reparse produces a new durable gallery plan without changing the old capture or plan", async () => {
  const f = await fixture({ images: 1, legacyGallery: true });
  const old = await f.plans.run({ input: f.input, receipt: f.receipt }, signal());
  const before = new Map([...f.remote.data].map(([k, v]) => [k, Buffer.from(v)]));
  const input = GncProductInputSchema.parse({ ...f.input, operationId: "product-v2", parseVersion: "gnc-product-html/2" });
  const next = await f.plans.run({ input, receipt: f.receipt }, signal());
  expect(next.status).toBe("prepared"); if (next.status !== "prepared") throw Error();
  const plan = (await f.plans.inspect(input, signal()))!;
  expect(plan.parsed?.producer.implementationVersion).toBe("gnc-product-html/2");
  const proof = JSON.parse(Buffer.from(f.remote.data.get(plan.parsed!.objectKey)!).toString());
  expect(proof.capture).toEqual(plan.capture);
  expect(proof.parserVersion).toBe(input.parseVersion);
  expect(proof.parsed.data.imageCandidates).toHaveLength(2);
  for (const [key, bytes] of before) expect(f.remote.data.get(key)).toEqual(bytes);
  expect(await f.plans.run({ input: f.input, receipt: null }, signal())).toEqual(old);
  const files = next.manifest.sources.filter(s => s.kind === "file-image");
  expect(await f.plans.fileSource(input, files[1]!.plan.acquire, signal())).toBe("https://www.gnc.com/back.png");
  expect((await f.plans.directFileSources(input, ["https://www.gnc.com"], "2099-01-01T00:00:00Z", signal())).map(s => s.url))
    .toEqual(["https://www.gnc.com/label-0.png", "https://www.gnc.com/back.png"]);
  const puts = f.remote.create.mock.calls.length;
  const cold = new GncProductPlans(new GncCaptureEvidence({ ...f.evidence.deps, local: new Memory() }));
  expect(await cold.run({ input, receipt: null }, signal())).toEqual(next);
  expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.read).toHaveBeenCalledTimes(1);
});
it("cannot opt an existing product operation into reparse or select an unsupported parser", async () => {
  const f = await fixture(); await f.plans.run({ input: f.input, receipt: null }, signal());
  const puts = f.remote.create.mock.calls.length;
  expect(await f.plans.run({ input: { ...f.input, parseVersion: "gnc-product-html/2" }, receipt: null }, signal()))
    .toMatchObject({ status: "review", code: "GNC.PLAN_CONFLICT" });
  expect(f.remote.create).toHaveBeenCalledTimes(puts);
  expect(GncProductInputSchema.safeParse({ ...f.input, parseVersion: "latest" }).success).toBe(false);
});
it.each(["missing", "corrupt", "owner"])("reparse rejects %s evidence without refetch or overwrite", async kind => {
  const f = await fixture();
  const input = GncProductInputSchema.parse({ ...f.input, operationId: "product-v2", parseVersion: "gnc-product-html/2" });
  await f.plans.run({ input, receipt: null }, signal());
  const plan = (await f.plans.inspect(input, signal()))!;
  if (kind === "missing") f.remote.data.delete(plan.parsed!.objectKey);
  if (kind === "corrupt") f.remote.data.set(plan.parsed!.objectKey, Buffer.from("tampered"));
  if (kind === "owner") input.task.owner.observationId = "foreign";
  const puts = f.remote.create.mock.calls.length;
  expect(await f.plans.run({ input, receipt: null }, signal())).toMatchObject({ status: "review" });
  expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.read).toHaveBeenCalledTimes(1);
});
it.each([true, false])("reparse publication acknowledgement (stored=%s) never causes a second PUT", async stored => {
  const f = await fixture(), create = f.remote.create.getMockImplementation()!;
  const input = GncProductInputSchema.parse({ ...f.input, operationId: "product-v2", parseVersion: "gnc-product-html/2" });
  const key = "v3/gnc-products/product-v2/parsed.json";
  f.remote.create.mockImplementation(async (...args) => {
    if (args[0] !== key) return create(...args);
    if (stored) await create(...args);
    throw Error("lost acknowledgement");
  });
  const out = await f.plans.run({ input, receipt: null }, signal());
  expect(out.status).toBe(stored ? "prepared" : "review");
  const cold = new GncProductPlans(new GncCaptureEvidence({ ...f.evidence.deps, local: new Memory() }));
  expect(await cold.run({ input, receipt: null }, signal())).toEqual(out);
  expect(f.remote.create.mock.calls.filter(a => a[0] === key)).toHaveLength(1);
});
it.each([{ page: false, images: 2, kinds: ["file-image", "file-image"] }, { page: true, images: 0, kinds: ["page"] }])("allows independent page/image-only source sets %j", async options => {
  const f = await fixture(options), out = await f.plans.run({ input: f.input, receipt: null }, signal());
  if (out.status !== "prepared") throw Error(); expect(out.manifest.sources.map(s => s.kind)).toEqual(options.kinds);
});
it("empty-cache repeat verifies evidence without source reads, PUTs or operation changes", async () => {
  const f = await fixture(), out = await f.plans.run({ input: f.input, receipt: null }, signal()), puts = f.remote.create.mock.calls.length;
  const cold = new GncProductPlans(new GncCaptureEvidence({ ...f.evidence.deps, local: new Memory() }));
  expect(await cold.run({ input: f.input, receipt: null }, signal())).toEqual(out);
  expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.read).toHaveBeenCalledTimes(1);
});
it("private direct file grants preserve exact candidate URLs and require explicit trusted origins and expiry", async () => {
  const f = await fixture(); await f.plans.run({ input: f.input, receipt: null }, signal());
  const puts = f.remote.create.mock.calls.length;
  const sources = await f.plans.directFileSources(f.input, ["https://www.gnc.com"], "2099-01-01T00:00:00Z", signal());
  expect(sources.map(s => s.url)).toEqual(["https://www.gnc.com/label-0.png", "https://www.gnc.com/label-1.png"]);
  await expect(f.plans.directFileSources(f.input, ["https://other.example"], "2099-01-01T00:00:00Z", signal())).rejects.toThrow("SOURCE.ORIGIN_BLOCKED");
  await expect(f.plans.directFileSources(f.input, ["https://www.gnc.com"], "2000-01-01T00:00:00Z", signal())).rejects.toThrow("SOURCE.SESSION_UNAVAILABLE");
  const indirect = structuredClone(f.input); indirect.task.network = { routeId: "host", version: "1", mode: "host", managed: false, egressId: "host/1" }; indirect.task.capture.binding.egressId = "host/1";
  await expect(f.plans.directFileSources(indirect, ["https://www.gnc.com"], "2099-01-01T00:00:00Z", signal())).rejects.toThrow("NETWORK.CAPABILITY_UNAVAILABLE");
  expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.read).toHaveBeenCalledTimes(1);
});
it.each(["fragment", "plan"])("a lost %s upload acknowledgement reconciles without a second PUT", async kind => {
  const f = await fixture(), create = f.remote.create.getMockImplementation()!;
  const key = kind === "plan" ? gncProductKey(f.input) : "v3/gnc-products/product/product.html";
  f.remote.create.mockImplementation(async (...args) => { const out = await create(...args); if (args[0] === key) throw Error("lost ack"); return out; });
  expect(await f.plans.run({ input: f.input, receipt: null }, signal())).toMatchObject({ status: "prepared" });
  expect(f.remote.create.mock.calls.filter(a => a[0] === key)).toHaveLength(1);
});
it("unknown plan upload becomes stable passive Review, never retried from a cold planner", async () => {
  const f = await fixture(), create = f.remote.create.getMockImplementation()!, key = gncProductKey(f.input);
  f.remote.create.mockImplementation(async (...args) => { if (args[0] === key) throw Error("secret"); return create(...args); });
  const out = await f.plans.run({ input: f.input, receipt: null }, signal());
  expect(out).toMatchObject({ status: "review", code: "GNC.PUBLICATION_UNKNOWN" });
  const cold = new GncProductPlans(new GncCaptureEvidence({ ...f.evidence.deps, local: new Memory() }));
  expect(await cold.run({ input: f.input, receipt: null }, signal())).toEqual(out);
  expect(f.remote.create.mock.calls.filter(a => a[0] === key)).toHaveLength(1); expect(f.rows.size).toBe(1);
});
it.each(["profile", "owner", "receipt", "fragment"])("rejects mismatched %s without recapturing", async kind => {
  const f = await fixture(); await f.plans.run({ input: f.input, receipt: null }, signal());
  const input = structuredClone(f.input), receipt = structuredClone(f.receipt);
  if (kind === "profile") input.visionConfigFingerprint = "d".repeat(64);
  if (kind === "owner") input.task.owner.observationId = "foreign";
  if (kind === "receipt") receipt.operationId = "foreign";
  if (kind === "fragment") f.remote.data.set("v3/gnc-products/product/product.html", Buffer.from("tampered"));
  expect(await f.plans.run({ input, receipt }, signal())).toMatchObject({ status: "review" }); expect(f.read).toHaveBeenCalledTimes(1);
});
it("no usable sources and too many sources become classified Review, never silent truncation", async () => {
  for (const [options, code] of [[{ page: false, images: 0 }, "GNC.NO_PRODUCT_SOURCES"], [{ images: 100 }, "GNC.PRODUCT_SOURCE_LIMIT"]] as const) {
    const f = await fixture(options); expect(await f.plans.run({ input: f.input, receipt: null }, signal())).toMatchObject({ status: "review", code });
  }
});
it("file sources require queues and unique matching owner/stage operations in the shared contract", async () => {
  const f = await fixture(), out = await f.plans.run({ input: f.input, receipt: null }, signal()); if (out.status !== "prepared") throw Error();
  const queues = { page: "p", pageText: "pt", text: "t", textReceipts: "tr", ocr: "o", ocrReceipts: "or", keywords: "k", vision: "v", assembly: "a", collection: "c" };
  expect(SavedProductWorkflowInputSchema.safeParse({ manifest: out.manifest, queues }).success).toBe(false);
  const q = { ...queues, acquire: "f", imagePrepare: "i" };
  expect(SavedProductWorkflowInputSchema.safeParse({ manifest: out.manifest, queues: q }).success).toBe(true);
  expect(SavedProductWorkflowInputSchema.safeParse({ manifest: { ...out.manifest, sources: [...out.manifest.sources, { ...out.manifest.sources[1], id: "copy" }] }, queues: q }).success).toBe(false);
});

async function fileFixture(proxy = false) {
  const f = await fixture({ proxy });
  await f.plans.run({ input: f.input, receipt: null }, signal());
  const plan = (await f.plans.inspect(f.input, signal()))!;
  const files = plan.manifest.sources.filter(s => s.kind === "file-image").map(s => s.plan.acquire);
  const transport = { egressId: f.input.task.network.egressId, get: vi.fn(async () => ({ status: 200,
    headers: { "content-type": "image/png" }, body: (async function* () { yield png; })(), close() {} })) };
  const route = { selection: f.input.task.network, capabilities: ["http", "binary"] as const, transport };
  const grant = { input: f.input, allowedOrigins: ["https://www.gnc.com", "https://cdn.example"], expiresAt: "2099-01-01T00:00:00Z",
    headersByOrigin: { "https://www.gnc.com": { cookie: "synthetic" } } };
  return { ...f, files, route, grant, transport, access: new GncFileSources(f.plans, route, [grant]) };
}
async function sessionFixture() {
  const f = await fileFixture(true);
  const browser = { ...f.input.task.capture.binding, exportFiles: vi.fn(async (urls: readonly string[]) => ({
    ...f.input.task.capture.binding, browserId: "synthetic-browser", resources: urls.map((url, index) => ({ url,
      expiresAt: "2098-01-01T00:00:00Z", headers: { cookie: `synthetic-${index}` } })) })) };
  const grant = await prepareGncFileGrant(f.plans, browser, f.input, f.grant.allowedOrigins, f.grant.expiresAt, signal());
  return { ...f, browser, sessionGrant: grant };
}
it("exports a published product's exact file grants consumable without a browser reference", async () => {
  const f = await sessionFixture(), serialized = JSON.stringify(f.sessionGrant), puts = f.remote.create.mock.calls.length;
  const access = new GncFileSources(f.plans, f.route, JSON.parse(`[${serialized}]`));
  f.browser.exportFiles.mockRejectedValue(Error("Browser gone"));
  await Promise.all(f.files.map(i => acquireFile(i, { access, dns: { resolve: async () => [{ address: "8.8.8.8", family: 4 }] } }, signal())));
  expect(f.transport.get.mock.calls.map(c => (c as unknown as [URL, unknown, object])[2])).toEqual([{ cookie: "synthetic-0" }, { cookie: "synthetic-1" }]);
  expect(f.browser.exportFiles).toHaveBeenCalledTimes(1); expect(f.remote.create).toHaveBeenCalledTimes(puts);
  expect(JSON.stringify((await f.plans.inspect(f.input, signal()))!.manifest)).not.toContain("synthetic-");
  expect([...f.remote.data.values()].some(b => Buffer.from(b).includes("synthetic-"))).toBe(false);
});
it.each(["path", "query", "origin"])("exact-URL grant never propagates credentials on a %s redirect", async kind => {
  const f = await sessionFixture();
  f.transport.get.mockImplementationOnce(async () => ({ status: 302, headers: { location: kind === "origin" ? "https://cdn.example/a.png" : kind === "query" ? "/label-0.png?v=2" : "/other.png" }, body: (async function* () {})(), close() {} }) as any);
  const access = new GncFileSources(f.plans, f.route, [f.sessionGrant]);
  await acquireFile(f.files[0]!, { access, dns: { resolve: async () => [{ address: "8.8.8.8", family: 4 }] } }, signal());
  expect((f.transport.get.mock.calls[0] as unknown as [URL, unknown, object])[2]).toEqual({ cookie: "synthetic-0" });
  expect((f.transport.get.mock.calls[1] as unknown as [URL, unknown, object])[2]).toEqual({});
});
it.each(["missing", "url", "task", "expired", "mixed"])("invalid resource grant %s cannot download", async kind => {
  const f = await sessionFixture(), g = structuredClone(f.sessionGrant);
  if (kind === "missing") g.resources = [];
  if (kind === "url") g.resources![0]!.url = "https://www.gnc.com/wrong.png";
  if (kind === "task") g.resources![0]!.input.operationId = "other";
  if (kind === "expired") g.resources![0]!.expiresAt = "2000-01-01T00:00:00Z";
  if (kind === "mixed") g.headersByOrigin = { "https://www.gnc.com": { cookie: "too-broad" } };
  await expect(async () => { const access = new GncFileSources(f.plans, f.route, [g]); await access.acquire(f.files[0]!, signal()); }).rejects.toThrow();
  expect(f.transport.get).not.toHaveBeenCalled();
});
it.each(["session", "origin", "unpublished"])("rejects %s before any cookie export", async kind => {
  const f = await sessionFixture(); f.browser.exportFiles.mockClear();
  if (kind === "session") f.browser.sessionId = "foreign";
  if (kind === "unpublished") f.remote.data.delete(gncProductKey(f.input));
  await expect(prepareGncFileGrant(f.plans, f.browser, f.input, kind === "origin" ? ["https://cdn.example"] : f.grant.allowedOrigins, f.grant.expiresAt, signal())).rejects.toThrow("SOURCE.SESSION_UNAVAILABLE");
  expect(f.browser.exportFiles).not.toHaveBeenCalled();
});
it.each([false, true])("private file adapter resolves each exact published URL on the selected route (proxy=%s)", async proxy => {
  const f = await fileFixture(proxy), puts = f.remote.create.mock.calls.length;
  const results = await Promise.all(f.files.map(i => acquireFile(i, { access: f.access, dns: { resolve: async () => [{ address: "8.8.8.8", family: 4 }] } }, signal())));
  expect(results.map(r => r.file.kind)).toEqual(["source-image", "source-image"]);
  expect(f.transport.get.mock.calls.map(c => (c as unknown as [URL])[0].href)).toEqual(["https://www.gnc.com/label-0.png", "https://www.gnc.com/label-1.png"]);
  expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.read).toHaveBeenCalledTimes(1);
});
it.each(["operationId", "resourceId", "observationId", "inputFingerprint", "binding"])("rejects a changed %s before any image request", async field => {
  const f = await fileFixture(), input = structuredClone(f.files[0]!);
  if (field === "binding") input.binding.sessionId = "other";
  else if (field === "inputFingerprint") input.inputFingerprint = "f".repeat(64);
  else (input as unknown as Record<string, unknown>)[field] = "foreign";
  await expect(f.access.acquire(input, signal())).rejects.toThrow("SOURCE.SESSION_MISMATCH");
  expect(f.transport.get).not.toHaveBeenCalled();
});
it("leases are independent, credentials stay on the initial origin, and caller config mutations are isolated", async () => {
  const f = await fileFixture(), a = await f.access.acquire(f.files[0]!, signal()), b = await f.access.acquire(f.files[1]!, signal());
  f.grant.headersByOrigin["https://www.gnc.com"].cookie = "changed";
  expect(a.headersFor("https://www.gnc.com")).toEqual({ cookie: "synthetic" });
  expect(a.headersFor("https://cdn.example")).toEqual({});
  await a.release(); expect(() => a.assertActive()).toThrow("SOURCE.SESSION_UNAVAILABLE"); expect(() => b.assertActive()).not.toThrow();
  await b.release();
});
it.each(["missing", "expired", "origin", "corrupt"])("%s authorization/evidence rejects file access without network or PUT", async kind => {
  const f = await fileFixture(), puts = f.remote.create.mock.calls.length;
  if (kind === "expired") f.grant.expiresAt = "2000-01-01T00:00:00Z";
  if (kind === "origin") { f.grant.allowedOrigins = ["https://cdn.example"]; f.grant.headersByOrigin = {} as typeof f.grant.headersByOrigin; }
  if (kind === "corrupt") f.remote.data.set(gncProductKey(f.input), Buffer.from("corrupt"));
  const access = new GncFileSources(f.plans, f.route, kind === "missing" ? [] : [f.grant]);
  await expect(access.acquire(f.files[0]!, signal())).rejects.toThrow();
  expect(f.transport.get).not.toHaveBeenCalled(); expect(f.remote.create).toHaveBeenCalledTimes(puts);
});
it("rejects route replacement, expiry and cancellation while resolving retained plan evidence", async () => {
  for (const kind of ["route", "expiry", "cancel"] as const) {
    const f = await fileFixture(), c = new AbortController();
    const access = new GncFileSources({ fileSource: async () => {
      if (kind === "route") f.route.selection.version = "changed";
      if (kind === "expiry") vi.spyOn(Date, "now").mockReturnValue(Date.parse("2100-01-01T00:00:00Z"));
      if (kind === "cancel") c.abort(new Error("cancelled"));
      return "https://www.gnc.com/image.png";
    } }, f.route, [f.grant]);
    try { await expect(access.acquire(f.files[0]!, c.signal)).rejects.toThrow(); }
    finally { vi.restoreAllMocks(); }
  }
});
it("configuration rejects mismatched full route, duplicate observation and transport override headers", async () => {
  const f = await fileFixture(true);
  expect(() => new GncFileSources(f.plans, { ...f.route, selection: { ...f.route.selection, version: "2" } }, [f.grant])).toThrow("NETWORK.ROUTE_MISMATCH");
  expect(() => new GncFileSources(f.plans, f.route, [f.grant, f.grant])).toThrow("NETWORK.CONFIG_INVALID");
  for (const headers of [{ Host: "evil" }, { "Proxy-Authorization": "secret" }, { Cookie: "a", cookie: "b" }, { cookie: "a\r\nb" }]) {
    expect(() => new GncFileSources(f.plans, f.route, [{ ...f.grant, headersByOrigin: { "https://www.gnc.com": headers } }])).toThrow();
  }
  expect(() => createHttpRoute({ routeId: "host", version: "1", mode: "host", managed: false, egressId: "host/1" })).toThrow("NETWORK.HOST_CLIENT_REQUIRED");
});
it("one blocked image origin does not invalidate another image lease", async () => {
  const f = await fileFixture();
  const access = new GncFileSources({ fileSource: async (_parent, file) => file.operationId === f.files[0]!.operationId
    ? "https://unapproved.example/private.png" : f.plans.fileSource(f.input, file, signal()) }, f.route, [f.grant]);
  const outcomes = await Promise.allSettled(f.files.map(file => access.acquire(file, signal())));
  expect(outcomes[0]!.status).toBe("rejected"); expect(outcomes[1]!.status).toBe("fulfilled");
  if (outcomes[1]!.status === "fulfilled") await outcomes[1]!.value.release();
});
