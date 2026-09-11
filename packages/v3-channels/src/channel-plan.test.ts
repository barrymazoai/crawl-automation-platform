import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SwansonRenderedProductSchema, ChannelPlanInputSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { sha256, ArtifactResolver, RetainedPublication, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { parseSwansonRenderedProduct, swansonProductAddress } from "./swanson-rendered.js";
import { ChannelProductPlans, channelPlanKey } from "./channel-plan.js";
const root = process.env.V3_CHANNEL_FIXTURE_ROOT;
if (!root) throw Error("Set V3_CHANNEL_FIXTURE_ROOT to the retained public fixtures on Mac mini");
const sample = (name = "swanson-product-public.json") => SwansonRenderedProductSchema.parse(JSON.parse(readFileSync(join(root, name), "utf8")));
const ownerOf = (p = sample()) => ({ schemaVersion: 1 as const, requestId: "channel-test", observationId: `obs-${p.selectedForms[0]!.productId}`,
  brandId: "ac-grace", sourceId: "swanson", listingId: p.selectedForms[0]!.productId, variantId: p.selectedForms[0]!.variantIds[0]! });
const signal = () => new AbortController().signal;
class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
  read = vi.fn(async (key: string, max: number) => { const b = this.data.get(key); if (b && b.length > max) throw Error("limit"); return b ?? null; });
  create = vi.fn(async (key: string, bytes: Uint8Array) => { if (this.data.has(key)) return "exists" as const; this.data.set(key, Buffer.from(bytes)); return "created" as const; });
}
function fixture(name?: string) {
  const p = sample(name), owner = ownerOf(p), bytes = Buffer.from(JSON.stringify(p));
  const input = ChannelPlanInputSchema.parse({ operationId: `plan-${owner.listingId}`, owner, channel: "swanson", parserVersion: "swanson-rendered/1",
    expectedUrl: p.url, binding: { sessionId: "ego-1", egressId: "host/1" }, source: { schemaVersion: 1, artifactId: `source-${owner.listingId}`,
      observationId: owner.observationId, sourceId: owner.sourceId, listingId: owner.listingId, variantId: owner.variantId,
      kind: "result-json", mediaType: "application/json", objectKey: `tests/${owner.listingId}/projection.json`, sha256: sha256(bytes), byteSize: bytes.length,
      producer: { operationId: `capture-${owner.listingId}`, module: "swanson.browser-projection", implementationVersion: "swanson-rendered/1" } },
    text: { schemaVersion: 1, module: "codex.text", implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2, configFingerprint: "a".repeat(64) },
    ocr: { schemaVersion: 1, module: "ocr.file", implementationVersion: "1", policyVersion: "1", resultSchemaVersion: 2, configFingerprint: "b".repeat(64) }, visionConfigFingerprint: "c".repeat(64) });
  const local = new Memory(), remote = new Memory(), rows = new Map<string, ReviewRecord>(); remote.data.set(input.source.objectKey, bytes);
  const reviews = { read: async (id: string) => rows.get(id) ?? null, append: async (r: ReviewRecord) => { if (!rows.has(r.reviewId)) rows.set(r.reviewId, structuredClone(r)); } };
  const resolver = new ArtifactResolver({ read: async () => null, retain: async () => {} }, remote);
  const publication = new RetainedPublication(local, remote), plans = new ChannelProductPlans(publication, resolver, reviews);
  return { p, input, bytes, local, remote, reviews, rows, resolver, publication, plans };
}
it.each(["swanson-product-public.json", "swanson-second-public.json"])("real retained DOM projection: %s", name => {
  const p = sample(name), r = parseSwansonRenderedProduct(p, p.url, ownerOf(p));
  expect(r.imageCandidates).toHaveLength(3); expect(r.imageCandidates.every(i => i.variantId === ownerOf(p).variantId && !i.verifiedOriginal)).toBe(true);
  expect(r.factsCandidates[0]!.html).toContain("Other Ingredients"); expect(r.variants).toEqual([]);
  expect(r.warnings).toContain("SWANSON.VARIANT_ENUMERATION_UNVERIFIED");
});
it("canonical /p and collection /p identify the same product without inventing /products or a variant URL", () => {
  const p = sample(); expect(parseSwansonRenderedProduct(p, p.canonicalUrl, ownerOf(p)).url).toBe(p.url);
  expect(swansonProductAddress(p.url).handle).toBe(swansonProductAddress(p.canonicalUrl).handle);
});
it.each([
  ["foreign canonical", (p: ReturnType<typeof sample>) => { p.canonicalUrl = "https://www.swansonvitamins.com/p/other"; }],
  ["foreign product form", (p: ReturnType<typeof sample>) => { p.selectedForms[0]!.productId = "123"; }],
  ["foreign selected variant", (p: ReturnType<typeof sample>) => { p.selectedForms[0]!.variantIds = ["123"]; }],
  ["multiple product forms", (p: ReturnType<typeof sample>) => { p.selectedForms.push(p.selectedForms[0]!); }],
  ["multiple variant inputs", (p: ReturnType<typeof sample>) => { p.selectedForms[0]!.variantIds.push("123"); }],
  ["duplicate facts", (p: ReturnType<typeof sample>) => { p.sections.push(p.sections[1]!); }],
  ["untrusted image host", (p: ReturnType<typeof sample>) => { p.gallery[0]!.url = "https://evil.example/label.jpg"; }],
  ["credential query", (p: ReturnType<typeof sample>) => { p.gallery[0]!.url += "&token=do-not-retain"; }],
] as const)("rejects %s", (_name, mutate) => { const p = sample(), owner = ownerOf(p); mutate(p); expect(() => parseSwansonRenderedProduct(p, sample().url, owner)).toThrow(); });
it.each(["http://www.swansonvitamins.com/p/product", "https://www.swansonvitamins.com/products/product", "https://www.swansonvitamins.com/p/product?variant=1&variant=2", "https://www.swansonvitamins.com/p/product#fragment"])("rejects unsupported product address %s", url => expect(() => swansonProductAddress(url)).toThrow());
it("requires explicit selected variant proof for query requests", () => {
  const p = sample(); expect(() => parseSwansonRenderedProduct(p, `${p.canonicalUrl}?variant=123`, ownerOf(p))).toThrow();
  p.url += `?variant=${ownerOf(p).variantId}`; expect(parseSwansonRenderedProduct(p, p.url, ownerOf(p)).variantId).toBe(ownerOf(p).variantId);
});
it("escapes DOM text; does not turn projection text into executable source HTML", () => {
  const p = sample(); p.sections[0]!.text = 'Product Details\n<script>alert("x")</script>&';
  const r = parseSwansonRenderedProduct(p, p.url, ownerOf(p)); expect(r.detailsHtml).toContain("&lt;script&gt;"); expect(r.detailsHtml).not.toContain("<script>");
});
it("heading-only facts are not nutrition content; duplicate gallery URLs are deduplicated", () => {
  const p = sample(); p.sections[1]!.text = "Product Facts\nSupplement Facts"; p.gallery.push(p.gallery[0]!);
  const r = parseSwansonRenderedProduct(p, p.url, ownerOf(p)); expect(r.factsCandidates).toEqual([]); expect(r.imageCandidates).toHaveLength(3);
});
it("rejects unknown fields, rather than retaining scripts or private page state", () => {
  const p = sample(); expect(() => parseSwansonRenderedProduct({ ...p, scripts: "private" }, p.url, ownerOf(p))).toThrow();
});
it.each(["swanson-product-public.json", "swanson-second-public.json"])("prepares four independent source tasks from %s without browser/OCR/model ports", async name => {
  const f = fixture(name), r = await f.plans.run(f.input, signal()); expect(r.status).toBe("prepared");
  if (r.status !== "prepared") throw Error("unexpected Review");
  expect(r.manifest.sources).toHaveLength(4); expect(r.manifest.sources.filter(s => s.kind === "file-image")).toHaveLength(3);
  expect(JSON.stringify(r)).not.toContain("https://"); expect(f.rows.size).toBe(0);
  const plan = (await f.plans.inspect(f.input, signal()))!; expect(plan.fragment!.producer.module).toBe("channel.product-input");
  const puts = f.remote.create.mock.calls.length; expect(await f.plans.run(f.input, signal())).toEqual(r); expect(f.remote.create).toHaveBeenCalledTimes(puts);
  const cold = new ChannelProductPlans(new RetainedPublication(new Memory(), f.remote), f.resolver, f.reviews);
  expect(await cold.run(f.input, signal())).toEqual(r); expect(f.remote.create).toHaveBeenCalledTimes(puts);
});
it("file lookup only resolves exact durable product tasks; foreign source cannot steal a gallery URL", async () => {
  const f = fixture(); await f.plans.run(f.input, signal()); const plan = (await f.plans.inspect(f.input, signal()))!;
  const source = plan.manifest.sources.find(s => s.kind === "file-image")!; if (source.kind !== "file-image") throw Error();
  expect(await f.plans.fileSource(f.input, source.plan.acquire, signal())).toBe(f.p.gallery[0]!.url);
  await expect(f.plans.fileSource(f.input, { ...source.plan.acquire, sourceId: "other" }, signal())).rejects.toThrow("SOURCE.SESSION_MISMATCH");
});
it("source hash corruption becomes passive artifact Review and is not automatically retried after repair", async () => {
  const f = fixture(); f.remote.data.set(f.input.source.objectKey, Buffer.from("corrupt"));
  const r = await f.plans.run(f.input, signal()); expect(r).toMatchObject({ status: "review", automaticRetry: false });
  f.remote.data.set(f.input.source.objectKey, f.bytes); const calls = f.remote.read.mock.calls.length;
  expect(await f.plans.run(f.input, signal())).toEqual(r); expect(f.remote.read).toHaveBeenCalledTimes(calls);
});
it("local-only source never claims cross-machine handoff completion", async () => {
  const f = fixture(); f.remote.data.delete(f.input.source.objectKey);
  const resolver = new ArtifactResolver({ read: async () => f.bytes, retain: async () => {} }, f.remote);
  const r = await new ChannelProductPlans(f.publication, resolver, f.reviews).run(f.input, signal());
  expect(r).toMatchObject({ status: "review", code: "CHANNEL.NOT_DURABLE" }); expect(f.local.data.has(channelPlanKey(f.input))).toBe(true);
  expect(f.remote.data.has(channelPlanKey(f.input))).toBe(false);
});
it("lost PUT acknowledgement reads back retained completion; no reprocessing or extra PUT", async () => {
  const f = fixture(), create = f.remote.create.getMockImplementation()!;
  f.remote.create.mockImplementation(async (key, bytes) => { const r = await create(key, bytes); if (key === channelPlanKey(f.input)) throw Error("lost ack"); return r; });
  expect(await f.plans.run(f.input, signal())).toMatchObject({ status: "prepared" });
  expect(f.remote.create.mock.calls.filter(c => c[0] === channelPlanKey(f.input))).toHaveLength(1); expect(f.rows.size).toBe(0);
});
it("unconfirmed publication retains candidate and blocks repeat PUT even from another machine", async () => {
  const local = new Memory(), remote = new Memory(), create = remote.create.getMockImplementation()!;
  remote.create.mockImplementation(async (key, bytes) => { if (key === "out/result.json") throw Error("lost before storage"); return create(key, bytes); });
  const bytes = Buffer.from("result"), p = new RetainedPublication(local, remote);
  await expect(p.publish("out/result.json", bytes, "application/json", signal())).rejects.toThrow("ARTIFACT.UPLOAD_UNKNOWN");
  await expect(p.publish("out/result.json", bytes, "application/json", signal())).rejects.toThrow("ARTIFACT.UPLOAD_UNKNOWN");
  await expect(new RetainedPublication(new Memory(), remote).publish("out/result.json", bytes, "application/json", signal())).rejects.toThrow("ARTIFACT.UPLOAD_UNKNOWN");
  expect(remote.create.mock.calls.filter(c => c[0] === "out/result.json")).toHaveLength(1); expect(local.data.get("out/result.json")).toEqual(bytes);
});
it("conflicting operation reuse cannot overwrite another retained product", async () => {
  const f = fixture(); expect((await f.plans.run(f.input, signal())).status).toBe("prepared");
  const puts = f.remote.create.mock.calls.length;
  expect(await f.plans.run({ ...f.input, visionConfigFingerprint: "f".repeat(64) }, signal())).toMatchObject({ status: "review", code: "CHANNEL.PLAN_CONFLICT" });
  expect(f.remote.create).toHaveBeenCalledTimes(puts);
});
it("different products get disjoint downstream operation IDs", async () => {
  const a = fixture(), b = fixture("swanson-second-public.json");
  const ra = await a.plans.run(a.input, signal()), rb = await b.plans.run(b.input, signal());
  if (ra.status !== "prepared" || rb.status !== "prepared") throw Error();
  const ids = (r: typeof ra) => r.manifest.sources.flatMap(s => s.kind === "file-image" ? [s.plan.acquire.operationId, s.plan.ocrOperationId, s.visionOperationId] : s.kind === "page" ? [s.plan.page.operationId, s.plan.textOperationId] : []);
  expect(ids(ra).filter(i => ids(rb).includes(i))).toEqual([]);
});
