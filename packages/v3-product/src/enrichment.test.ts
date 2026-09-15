import { describe, expect, it } from "vitest";
import { ENRICHMENT_PROTOCOL, ReviewRecordSchema } from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { ProductEnrichment, enrichmentIdFor, formulaContentHash } from "./enrichment.js";
import { labelProductFixture } from "./label-product.fixture.js";

const signal = () => new AbortController().signal;
/** A real collected record from the label pipeline fixture (valid against LabelCollectedProductSchema). */
async function collected(operationId = "label-product", mutate?: (r: any) => void) {
  const f = await labelProductFixture(); const out = await f.assembly.run(f.join, signal());
  if (out.status !== "ready") throw Error("fixture assembly failed: " + JSON.stringify(out));
  const result = await f.collector.run({ join: f.join, evidenceKey: out.evidenceKey }, signal());
  if (result.status !== "collected") throw Error("fixture collection failed");
  const r = structuredClone([...f.collected.values()][0]!) as any; r.operationId = operationId; mutate?.(r); return r;
}
function fixture(opts: { response?: string | (() => string); fail?: boolean } = {}) {
  const collections = new Map<string, unknown>(), registry = new Map<string, unknown>(), objects = new Map<string, Uint8Array>(), reviews = new Map<string, any>();
  let calls = 0;
  const deps = {
    provider: { provider: "fake-codex/1", async interpret() { calls++; if (opts.fail) throw Error("model down"); return typeof opts.response === "function" ? opts.response() : opts.response ?? JSON.stringify(candidate()); } },
    collections: { async read(id: string) { return collections.get(id) ?? null; } },
    captures: { async describe() { return { title: "Carlyle Vitamin D3 5000 IU, 400 Softgels", url: "https://www.amazon.com/dp/B0TEST00001" }; } },
    registry: { async read(id: string) { return registry.get(id) ?? null; }, async register(r: any) { if (!registry.has(r.enrichmentId)) registry.set(r.enrichmentId, r); } },
    publication: { async publish(key: string, bytes: Uint8Array) { if (objects.has(key)) throw Error("immutable"); objects.set(key, bytes); } },
    reviews: { async append(r: any) { reviews.set(r.reviewId, r); return { registered: true }; }, async read(id: string) { return reviews.get(id) ?? null; } },
  };
  return { deps, collections, registry, objects, reviews, calls: () => calls, module: new ProductEnrichment(deps) };
}
const candidate = () => ({ unifiedName: "Carlyle Vitamin D3 5000 IU Softgels, 400 Count", baseName: "Carlyle Vitamin D3 5000 IU", form: "softgel",
  variant: { count: 400, size: null, flavor: null, strength: "5000 IU" }, healthFunctions: ["bone health", "immune support"], confidence: 0.9, notes: null });

describe("product enrichment: once per listing + formula content, model never re-run for the same key", () => {
  it("first run calls the model, retains evidence and registers; the id is derived from listing and label content only", async () => {
    const f = fixture(); const c = await collected(); f.collections.set(c.operationId, c);
    const out = await f.module.run({ schemaVersion: 1, collectionOperationId: c.operationId }, signal());
    expect(out.status).toBe("registered"); if (out.status !== "registered") throw Error("unreachable");
    expect(out.reused).toBe(false); expect(out.candidate.form).toBe("softgel"); expect(f.calls()).toBe(1);
    expect(out.enrichmentId).toBe(enrichmentIdFor(c.observation.listingId, formulaContentHash(c)));
    expect(f.objects.has(`v3/product-enrichment/${out.enrichmentId}.json`)).toBe(true);
    const saved = f.registry.get(out.enrichmentId) as any; expect(saved.protocol).toBe(ENRICHMENT_PROTOCOL); expect(saved.collectionOperationId).toBe(c.operationId);
  });
  it("a second crawl of the same listing with the same label content is skipped, even from a different collection operation", async () => {
    const f = fixture(); const first = await collected("label-op-1"), second = await collected("label-op-2"); f.collections.set(first.operationId, first); f.collections.set(second.operationId, second);
    const a = await f.module.run({ schemaVersion: 1, collectionOperationId: first.operationId }, signal());
    const b = await f.module.run({ schemaVersion: 1, collectionOperationId: second.operationId }, signal());
    expect(b).toMatchObject({ status: "registered", reused: true, enrichmentId: (a as any).enrichmentId }); expect(f.calls()).toBe(1);
  });
  it("citations do not change the key; changed label content does", async () => {
    const base = await collected();
    const sameContent = await collected("label-op-9", r => { r.assembly = { ...r.assembly, byteSize: r.assembly.byteSize + 1 }; r.warnings = [...r.warnings, { id: "w-extra", code: "TEST.NOISE" }]; });
    expect(formulaContentHash(sameContent)).toBe(formulaContentHash(base));
    const changed = await collected("label-op-3", r => { r.ingredients[0].name.text = r.ingredients[0].name.text + " (modified)"; });
    expect(formulaContentHash(changed)).not.toBe(formulaContentHash(base));
  });
  it("invalid model output becomes a Review with executed fact and no registration", async () => {
    const f = fixture({ response: "not json" }); const c = await collected(); f.collections.set(c.operationId, c);
    const out = await f.module.run({ schemaVersion: 1, collectionOperationId: c.operationId }, signal());
    expect(out).toMatchObject({ status: "review", code: "ENRICH.OUTPUT_INVALID" }); if (out.status !== "review") throw Error("unreachable");
    const review = ReviewRecordSchema.parse(f.reviews.get(out.reviewId)); expect(review.failure.stage).toBe("product.enrich"); expect(review.failure.executionFact).toBe("executed");
    expect(f.registry.size).toBe(0);
    // Next attempt runs the model again because nothing was registered.
    const g = fixture(); g.collections.set(c.operationId, c); expect((await g.module.run({ schemaVersion: 1, collectionOperationId: c.operationId }, signal())).status).toBe("registered");
  });
  it("provider failure is a Review with unknown execution; a missing collection is a typed error", async () => {
    const f = fixture({ fail: true }); const c = await collected(); f.collections.set(c.operationId, c);
    const out = await f.module.run({ schemaVersion: 1, collectionOperationId: c.operationId }, signal());
    expect(out).toMatchObject({ status: "review", code: "ENRICH.PROVIDER_FAILED" });
    await expect(f.module.run({ schemaVersion: 1, collectionOperationId: "label-op-missing" }, signal())).rejects.toMatchObject({ code: "ENRICH.COLLECTION_MISSING" });
    expect(sha256(Buffer.from("x"))).toHaveLength(64);
  });
});
