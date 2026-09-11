import { randomUUID } from "node:crypto";
import { ArtifactResolver, sha256 } from "@crawl-automation/v3-artifacts";
import { ArtifactRefSchema, textFingerprint, TextInputSchema, textObservation, type TextRecord, type ReviewRecord, type ArtifactRef } from "@crawl-automation/v3-contracts";
import { digest, parseRecord } from "@crawl-automation/v3-review";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { TextEvidence } from "./evidence.js";
import { TextHandoff, hashText } from "./handoff.js";
import { TextModule } from "./module.js";
import type { TextProvider, TextRegistry } from "./ports.js";
export const signal = () => new AbortController().signal;
export class MemoryTextRegistry implements TextRegistry {
    data = new Map<string, TextRecord>();
    lost = false;
    unavailable = false;
    async read(id: string) { return this.data.get(id) ?? null; }
    async register(record: TextRecord) {
        if (this.unavailable)
            throw Error("synthetic unavailable");
        const old = this.data.get(record.input.operationId);
        if (old && JSON.stringify(old) !== JSON.stringify(record))
            throw Error("conflict");
        this.data.set(record.input.operationId, record);
        if (this.lost)
            throw Error("synthetic lost acknowledgement");
    }
}
export class MemoryTextReviews {
    records = new Map<string, ReviewRecord>();
    lost = false;
    async read(id: string) { return this.records.get(id) ?? null; }
    async append(raw: ReviewRecord) {
        const record = parseRecord(raw);
        this.records.set(record.reviewId, record);
        if (this.lost)
            throw Error("lost acknowledgement");
        return { registered: true as const, reviewId: record.reviewId, recordHash: digest(record) };
    }
}
export function fixture(text = "Vitamin C 10 mg\nIngredients: water") {
    const id = randomUUID(), remote = new MemoryObjects(), local = new MemoryObjects();
    const owner = { schemaVersion: 1 as const, requestId: `req-${id}`, observationId: `obs-${id}`, brandId: "brand-test", sourceId: "source-test", listingId: `listing-${id}`, variantId: null };
    const artifact = (kind: "source-html" | "result-json", bytes: Uint8Array, suffix: string): ArtifactRef => ArtifactRefSchema.parse({
        schemaVersion: 1, artifactId: `${suffix}-${id}`, observationId: owner.observationId, sourceId: owner.sourceId, listingId: owner.listingId, variantId: null,
        kind, mediaType: kind === "source-html" ? "text/html" : "application/json", objectKey: `sources/${id}/${suffix}`, sha256: sha256(bytes), byteSize: bytes.length,
        producer: { operationId: `prepare-${id}`, module: "page.prepare", implementationVersion: "fixture/1" },
    });
    const html = Buffer.from(`<p>${text}</p>`), source = artifact("source-html", html, "html");
    const document = { ...owner, producer: "page.prepare", source, pageIndex: null, text };
    const bytes = Buffer.from(JSON.stringify(document)), ref = artifact("result-json", bytes, "document");
    remote.data.set(source.objectKey, html);
    remote.data.set(ref.objectKey, bytes);
    const supported = { schemaVersion: 1 as const, module: "codex.text" as const, implementationVersion: "text/1", policyVersion: "extractive/1", resultSchemaVersion: 1 as const, configFingerprint: "a".repeat(64) };
    const unsigned = { ...owner, ...supported, operationId: `text-${id}`, source: { kind: "prepared" as const, document: ref }, range: { start: 0, end: text.length } };
    const input = TextInputSchema.parse({ ...unsigned, inputFingerprint: textFingerprint(unsigned, hashText) });
    let calls = 0, ocrInspections = 0;
    const provider: TextProvider = { provider: "fixture/1", supported, policy: { executionRetries: 0, internalModelRequests: "codex-managed", toolAccess: "runtime-profile", modelFallback: false, networkSwitching: false },
        interpret: async () => { calls++; return JSON.stringify({ formula: null, ingredients: { items: [{ text, start: 0, end: text.length }] } }); }, close: async () => { } };
    const cache = { read: async () => null, retain: async () => { } };
    const evidence = new TextEvidence(new ArtifactResolver(cache, remote), { inspect: async () => { ocrInspections++; throw Error("must not inspect OCR for prepared text"); } });
    const registry = new MemoryTextRegistry(), reviews = new MemoryTextReviews();
    const handoff = new TextHandoff(local, remote, registry, evidence, "fixture/1");
    const deps = { provider, handoff, reviews, nodeId: "test-node" };
    return { input, owner: textObservation(input), text, document, source, ref, local, remote, registry, reviews, evidence, handoff, provider, deps,
        module: new TextModule(deps), calls: () => calls, ocrInspections: () => ocrInspections };
}
