import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { ProductEvidenceJoinSchema, ReviewRecordSchema, type ProductEvidenceJoin, type ProductImageOutcome, type ReviewRecord,
  type TextInput, type TextRecord, type TextCandidate, type VisionTask, type VisionRecord, type VisionCandidate,
  type ProductResolvedEvidenceSource } from "@crawl-automation/v3-contracts";
import type { SavedSourceEvidence } from "./saved-sources.js";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { digest, visionFingerprint } from "@crawl-automation/v3-vision";
import { mergeProductEvidence, type VerifiedProductEvidence } from "./mixed-merge.js";
type Dependencies = { local: ObjectStore; remote: ObjectStore; saved?: Pick<SavedSourceEvidence, "resolve">;
  text: { readCandidate(input: TextInput, signal: AbortSignal): Promise<{ record: TextRecord; candidate: TextCandidate; fullText: string }> };
  vision: { readCandidate(input: VisionTask, signal: AbortSignal): Promise<{ record: VisionRecord; candidate: VisionCandidate }> };
  reviews: { read(id: string): Promise<ReviewRecord | null>; append(record: ReviewRecord): Promise<unknown> } };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
export const mixedAssemblyKey = (input: ProductEvidenceJoin) => `v3/product-evidence/${input.manifest.operationId}/assembly.json`;
/** Post-barrier verification/merge only. No model, polling, normalization guesses or collection writes. */
export class ProductEvidenceAssembly {
  constructor(private readonly deps: Dependencies) {}
  private async compute(input: ProductEvidenceJoin, signal: AbortSignal) {
    const states = new Map(input.states.map(s => [s.id, s]));
    if (states.size !== input.states.length || input.states.some(s => !input.manifest.sources.some(p => p.id === s.id))) throw Error("MIXED.IDENTITY_CONFLICT");
    if (states.size !== input.manifest.sources.length) throw Error("MIXED.BARRIER_INCOMPLETE");
    const entries: VerifiedProductEvidence[] = [], failures: { id: string; code: string }[] = [];
    const resolvedSources: ProductResolvedEvidenceSource[] = [], excluded: { id: string; code: string; blocking: boolean }[] = [];
    for (const original of input.manifest.sources) {
      signal.throwIfAborted(); const state = states.get(original.id)!;
      if (state.status === "rejected") throw Error("MIXED.RECEIPT_INVALID");
      let source: ProductResolvedEvidenceSource;
      if (original.kind === "page" || original.kind === "ocr-image" || original.kind === "pdf-text" || original.kind === "file-image") {
        if (!this.deps.saved) throw Error("MIXED.SAVED_ADAPTER_REQUIRED");
        const resolved = await this.deps.saved.resolve(original, state, signal);
        if (resolved.status !== "resolved") {
          excluded.push({ id: original.id, code: resolved.status === "not_matched" ? "SCREEN.NO_KEYWORDS" : resolved.code,
            blocking: resolved.status !== "not_matched" && original.required }); continue;
        }
        source = resolved.source;
        if (source.id !== original.id || source.required !== original.required) throw Error("MIXED.IDENTITY_CONFLICT");
      } else { source = original; if (state.status === "not_matched") throw Error("MIXED.RECEIPT_INVALID"); }
      resolvedSources.push(source);
      if (state.status === "review") {
        const raw = await this.deps.reviews.read(state.reviewId); if (!raw) throw Error("MIXED.REVIEW_UNVERIFIED");
        const r = ReviewRecordSchema.parse(raw), op = source.kind === "text" ? source.task.operationId : source.task.input.operationId;
        const fp = source.kind === "text" ? source.task.inputFingerprint : visionFingerprint(source.task);
        const stages = source.kind === "text" ? ["codex.text", "text.receipt"] : ["codex.vision"];
        if (r.reviewId !== state.reviewId || r.failure.operationId !== op || r.failure.inputFingerprint !== fp ||
          !stages.includes(r.failure.stage) || !equal(r.observation, input.manifest.observation)) throw Error("MIXED.IDENTITY_CONFLICT");
        failures.push({ id: source.id, code: r.failure.code }); continue;
      }
      try {
        if (source.kind === "text") entries.push({ id: source.id, kind: "text", ...await this.deps.text.readCandidate(source.task, signal) });
        else entries.push({ id: source.id, kind: "image", ...await this.deps.vision.readCandidate(source.task, signal) });
      } catch { signal.throwIfAborted(); failures.push({ id: source.id, code: "MIXED.EVIDENCE_UNVERIFIED" }); }
    }
    // Canonical order prevents completion arrival order from changing immutable output bytes.
    const canonical = { manifest: { ...input.manifest, sources: [...input.manifest.sources].sort((a, b) => a.id < b.id ? -1 : 1) },
      states: [...input.states].sort((a, b) => a.id < b.id ? -1 : 1) };
    const result = resolvedSources.length ? mergeProductEvidence({ ...input.manifest, sources: resolvedSources }, entries, failures)
      : { schemaVersion: 1 as const, codec: "product-evidence/1" as const, status: "review" as "review" | "ready",
        codes: ["VALIDATION.FORMULA_MISSING", "VALIDATION.INGREDIENTS_MISSING"], warnings: [] as { id: string; code: string }[],
        formula: null, ingredients: [], provenance: [] };
    result.codes = [...new Set([...result.codes, ...excluded.filter(e => e.blocking).map(e => e.code)])].sort();
    result.warnings.push(...excluded.filter(e => !e.blocking).map(({ id, code }) => ({ id, code })));
    result.warnings.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
    result.status = result.codes.length ? "review" : "ready";
    return { input: canonical, result };
  }
  async inspectReady(raw: unknown, key: string, signal: AbortSignal) {
    const input = ProductEvidenceJoinSchema.parse(raw), output = await this.compute(input, signal), expected = encode(output);
    if (output.result.status !== "ready" || key !== mixedAssemblyKey(input)) throw Error("MIXED.NOT_READY");
    const bytes = await this.deps.remote.read(key, 8 * 1024 * 1024, signal);
    if (!bytes || digest(bytes) !== digest(expected)) throw Error("MIXED.EVIDENCE_UNVERIFIED");
    return { output, key, bytes };
  }
  async run(raw: unknown, signal: AbortSignal): Promise<ProductImageOutcome> {
    const input = ProductEvidenceJoinSchema.parse(raw), key = mixedAssemblyKey(input);
    let codes: string[] = [], published = false;
    try {
      const output = await this.compute(input, signal), bytes = encode(output);
      codes = output.result.codes;
      if (bytes.length > 8 * 1024 * 1024) throw Error("MIXED.OUTPUT_LIMIT");
      const verify = (b: Uint8Array | null) => { if (!b || digest(b) !== digest(bytes)) throw Error("MIXED.HANDOFF_UNVERIFIED"); };
      const prior = await this.deps.remote.read(key, 8 * 1024 * 1024, signal);
      if (prior) verify(prior);
      else {
        if (await this.deps.local.read(key, 8 * 1024 * 1024, signal)) throw Error("MIXED.HANDOFF_PENDING");
        await this.deps.local.create(key, bytes, "application/json", signal);
        verify(await this.deps.local.read(key, 8 * 1024 * 1024, signal));
        const intentKey = `product-evidence-intents/${input.manifest.operationId}.json`, marker = encode({ sha256: digest(bytes), nonce: randomUUID() });
        let claimed;
        try { claimed = await this.deps.remote.create(intentKey, marker, "application/json", signal); } catch { throw Error("MIXED.HANDOFF_PENDING"); }
        if (claimed !== "created") throw Error("MIXED.HANDOFF_PENDING");
        const intent = await this.deps.remote.read(intentKey, 65536, signal);
        if (!intent || digest(intent) !== digest(marker)) throw Error("MIXED.HANDOFF_PENDING");
        try { await this.deps.remote.create(key, bytes, "application/json", signal); } catch { /* One GET, never retry PUT. */ }
        verify(await this.deps.remote.read(key, 8 * 1024 * 1024, signal));
      }
      published = true; codes = output.result.codes;
      if (!codes.length) return { status: "ready", evidenceKey: key };
    } catch (error) {
      const value = error instanceof Error ? error.message : "";
      codes = [...new Set([...codes, /^(MIXED|SAVED)\.[A-Z_]+$/.test(value) ? value : "MIXED.ASSEMBLY_UNRESOLVED"])];
    }
    const reviewId = `mixed-${randomUUID()}`, r = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId, occurredAt: new Date().toISOString(),
      failure: { schemaVersion: 1, requestId: input.manifest.observation.requestId, observationId: input.manifest.observation.observationId,
        operationId: input.manifest.operationId, inputFingerprint: digest(JSON.stringify(input)), stage: "product.evidence.assembly", category: "VALIDATION",
        code: codes[0], executionFact: published ? "executed" : "unknown", evidenceKey: key, blockedBy: null, automaticRetry: false },
      observation: input.manifest.observation, rawError: { name: "MixedAssemblyReview", message: "Evidence needs review", stack: null, details: { input, codes } },
      candidate: published ? { schema: "product-evidence-ref/1", value: { evidenceKey: key } } : null, inspection: { kind: "none" } });
    const reviewKey = `product-evidence-reviews/${reviewId}.json`, bytes = encode(r), retention = AbortSignal.timeout(10000);
    await this.deps.local.create(reviewKey, bytes, "application/json", retention);
    const saved = await this.deps.local.read(reviewKey, 8 * 1024 * 1024, retention);
    if (!saved || digest(saved) !== digest(bytes)) throw Error("MIXED.REVIEW_UNVERIFIED");
    try { await this.deps.reviews.append(r); } catch { /* Same-ID readback. */ }
    const confirmed = await this.deps.reviews.read(reviewId);
    if (!confirmed || !equal(ReviewRecordSchema.parse(confirmed), r)) throw Error("MIXED.REVIEW_UNVERIFIED");
    return { status: "review", evidenceKey: key, reviewId, codes, automaticRetry: false };
  }
}
