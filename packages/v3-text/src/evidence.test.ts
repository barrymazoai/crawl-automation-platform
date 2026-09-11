import { it, expect } from "vitest";
import { ArtifactResolver, sha256 } from "@crawl-automation/v3-artifacts";
import { LabelCorePreparation } from "@crawl-automation/v3-acquisition";
import { textFingerprint, TextInputSchema, assertTextQuotes, TextDocumentSchema } from "@crawl-automation/v3-contracts";
import { setup as setupOcr } from "../../v3-results/src/testing.fixture.js";
import { fixture, signal } from "./testing.fixture.js";
import { TextEvidence } from "./evidence.js";
import { TextHandoff, hashText } from "./handoff.js";
import { TextModule } from "./module.js";
it("requires a verified OCR registration; OCR computation alone does not unblock text", async () => {
    const upstream = await setupOcr(), f = fixture();
    const registration = await upstream.handoff.capture(upstream.input, upstream.output, signal());
    const input = { ...f.input, requestId: upstream.input.requestId, observationId: upstream.input.observationId, brandId: upstream.input.brandId,
        sourceId: upstream.input.sourceId, listingId: upstream.input.listingId, variantId: upstream.input.variantId,
        source: { kind: "ocr" as const, registration }, range: { start: 0, end: upstream.output.text.length } };
    input.inputFingerprint = textFingerprint(input, hashText);
    const evidence = new TextEvidence(new ArtifactResolver(upstream.local, upstream.remote), upstream.handoff);
    const handoff = new TextHandoff(f.local, upstream.remote, f.registry, evidence, "fixture-r2/1");
    let calls = 0;
    f.provider.interpret = async () => { calls++; return JSON.stringify({ formula: null, ingredients: null }); };
    const module = new TextModule({ ...f.deps, handoff });
    expect(await module.run(input, signal())).toMatchObject({ code: "TEXT.UPSTREAM_UNVERIFIED" });
    expect(calls).toBe(0);
    expect(upstream.remote.data.has(`text-intents/${input.operationId}.json`)).toBe(false);
    expect([...f.reviews.records.values()][0]!.failure.blockedBy).toBe(upstream.input.operationId);
    await upstream.handoff.uploadMissing(upstream.input, signal());
    await upstream.handoff.register(upstream.input, signal());
    expect((await module.run(input, signal())).status).toBe("registered");
    expect(calls).toBe(1);
    expect(TextInputSchema.safeParse({ ...input, brandId: "other" }).success).toBe(false);
    expect(TextInputSchema.safeParse({ ...input, requestId: "other" }).success).toBe(false);
});
it("half-open ranges reject out-of-range quotes and surrogate splits", async () => {
    const f = fixture("A😀BC"), input = { ...f.input, range: { start: 2, end: 4 } };
    input.inputFingerprint = textFingerprint(input, hashText);
    expect(await f.module.run(input, signal())).toMatchObject({ code: "TEXT.RANGE_INVALID" });
    expect(f.calls()).toBe(0);
    const narrowed = { ...input, range: { start: 3, end: 5 } };
    expect(() => assertTextQuotes({ formula: null, ingredients: { items: [{ text: "A", start: 0, end: 1 }] } }, narrowed, f.text)).toThrow();
});
it("PDF provenance cannot be attached to HTML or omit page index", () => {
    const f = fixture();
    expect(TextDocumentSchema.safeParse(f.document).success).toBe(true);
    expect(TextDocumentSchema.safeParse({ ...f.document, producer: "pdf.text" }).success).toBe(false);
    expect(TextDocumentSchema.safeParse({ ...f.document, pageIndex: 0 }).success).toBe(false);
});
it("new core documents are recomputed from original HTML, not trusted merely for having a valid hash", async () => {
    const f = fixture(), owner = { ...f.owner, sourceId: "gnc" };
    const html = Buffer.from('<div class="product-nutrition-description"><table><tr><td>Serving Size: 2</td></tr><tr><th>Amount Per Serving</th></tr><tr><td>Vitamin C</td><td>10 mg</td></tr></table><div class="pdp-details-accordion__section"><h4>Other Ingredients</h4><div class="pdp-details-accordion__section-content">Pectin</div></div></div>');
    const source = { ...f.source, sourceId: "gnc", byteSize: html.length, sha256: sha256(html),
        producer: { operationId: "core-source", module: "gnc.product-input", implementationVersion: "1" } };
    f.remote.data.set(source.objectKey, html);
    const resolver = new ArtifactResolver({ read: async () => null, retain: async () => {} }, f.remote), preparation = new LabelCorePreparation(resolver, f.remote);
    const result = await preparation.run(owner, source, signal());
    const unsigned = { ...f.input, ...owner, source: { kind: "prepared" as const, document: result.ref }, range: { start: 0, end: result.document.text.length } };
    const input = TextInputSchema.parse({ ...unsigned, inputFingerprint: textFingerprint(unsigned, hashText) });
    const evidence = new TextEvidence(resolver, { inspect: async () => { throw Error("Unexpected OCR"); } });
    expect((await evidence.resolve(input, signal())).text).toBe(result.document.text);
    const writes = f.remote.writes;
    expect(await preparation.run(owner, source, signal())).toEqual(result); expect(f.remote.writes).toBe(writes);
    const modified = Buffer.from(JSON.stringify({ ...result.document, text: result.document.text.replace("10 mg", "99 mg") }));
    const ref = { ...result.ref, objectKey: "tampered/core.json", sha256: sha256(modified), byteSize: modified.length };
    f.remote.data.set(ref.objectKey, modified);
    await expect(evidence.resolve({ ...input, source: { kind: "prepared", document: ref } }, signal())).rejects.toMatchObject({ code: "TEXT.SOURCE_CONFLICT" });
});
