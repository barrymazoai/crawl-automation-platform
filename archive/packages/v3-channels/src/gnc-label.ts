import { isDeepStrictEqual as equal } from "node:util";
import { GncLabelInputSchema, GncLabelOutcomeSchema, LabelProductManifestSchema, TextInputSchema, textFingerprint,
  ReviewRecordSchema, GncLabelPlanOutcomeSchema, GncLabelSourceInputSchema, GncLabelSourceOutcomeSchema, LabelCoreOutcomeSchema, type LabelCoreInput, type LabelCoreOutcome,
  type GncLabelInput, type GncLabelOutcome, type GncLabelSourceOutcome, type SavedEvidenceSource, type ProductResolvedEvidenceSource } from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { GncCaptureEvidence } from "./gnc-handoff.js";
import { GncProductPlans } from "./gnc-product.js";
type Resolution = { status: "resolved"; source: ProductResolvedEvidenceSource } | { status: "not_matched" } | { status: "review"; code: string };
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)), limit = 2 * 1024 * 1024;
export const gncLabelKey = (i: GncLabelInput) => `v3/gnc-label-inputs/${i.operationId}/manifest.json`;
/** Compile already prepared evidence only. No browser, file download, OCR or model execution ports. */
export class GncLabelPlans {
  constructor(private readonly evidence: GncCaptureEvidence,
    private readonly resolve: (source: SavedEvidenceSource, signal: AbortSignal) => Promise<Resolution>,
    private readonly readCore?: (input: LabelCoreInput, signal: AbortSignal) => Promise<LabelCoreOutcome>) {}
  private async core(input: GncLabelInput, fullDocument: LabelCoreInput["fullDocument"], signal: AbortSignal) {
    if (!this.readCore) throw Error("GNC.LABEL_CORE_UNAVAILABLE");
    const request = { owner: input.sourcePlan.task.owner, fullDocument }, result = LabelCoreOutcomeSchema.parse(await this.readCore(request, signal));
    if (!equal(result.input, request)) throw Error("GNC.LABEL_IDENTITY_CONFLICT");
    return result;
  }
  async load(raw: unknown, signal: AbortSignal) {
    const input = GncLabelInputSchema.parse(raw);
    const plan = await new GncProductPlans(this.evidence).inspect(input.sourcePlan, signal);
    if (!plan) throw Error("GNC.LABEL_SOURCE_UNVERIFIED");
    return GncLabelPlanOutcomeSchema.parse({ input, manifest: plan.manifest });
  }
  private async resolveOne(input: GncLabelInput, source: SavedEvidenceSource, signal: AbortSignal): Promise<GncLabelSourceOutcome> {
      const request = { input, sourceId: source.id };
      signal.throwIfAborted();
      if (source.kind !== "page" && source.kind !== "file-image") throw Error("GNC.LABEL_SOURCE_UNSUPPORTED");
      const resolved = await this.resolve(source, signal);
      if (resolved.status === "review") throw Error("GNC.LABEL_PREPARATION_UNVERIFIED");
      if (resolved.status === "not_matched") {
        if (source.kind !== "file-image") throw Error("GNC.LABEL_IDENTITY_CONFLICT");
        return { status: "not_matched", input: request };
      }
      const r = resolved.source, operationId = `gncl-${sha256(encode([input.operationId, source.id]))}`;
      if (r.id !== source.id || r.kind !== (source.kind === "page" ? "text" : "image")) throw Error("GNC.LABEL_IDENTITY_CONFLICT");
      if (r.kind === "text") {
        if (source.kind !== "page" || r.task.operationId !== source.plan.textOperationId || r.task.source.kind !== "prepared" ||
          r.task.source.document.producer.operationId !== source.plan.page.operationId || r.task.range.start !== 0) throw Error("GNC.LABEL_IDENTITY_CONFLICT");
        const { inputFingerprint: _old, ...unsigned } = r.task;
        const next = { ...unsigned, ...input.text, operationId };
        if (input.corePolicy) {
          const core = await this.core(input, r.task.source.document, signal);
          next.source = { kind: "prepared", document: core.document }; next.range = core.range;
        }
        return GncLabelSourceOutcomeSchema.parse({ status: "prepared", input: request, source: { id: source.id, kind: "text", required: true,
          task: TextInputSchema.parse({ ...next, inputFingerprint: textFingerprint(next, s => sha256(Buffer.from(s))) }) } });
      } else {
        if (source.kind !== "file-image" || r.task.input.operationId !== source.visionOperationId ||
          r.task.input.selection.ocrOperationId !== source.plan.ocrOperationId || r.task.input.selection.image.artifactId !== source.plan.imageId ||
          r.task.input.selection.status !== "matched") throw Error("GNC.LABEL_IDENTITY_CONFLICT");
        return GncLabelSourceOutcomeSchema.parse({ status: "prepared", input: request, source: { id: source.id, kind: "image", required: true, task: { configFingerprint: input.visionConfigFingerprint,
          input: { operationId, extractionProtocol: "label-extraction/1", selection: r.task.input.selection } } } });
      }
  }
  /** Only the requested source is inspected; unrelated slow/missing preparations do not block it. */
  async source(raw: unknown, signal: AbortSignal) {
    const request = GncLabelSourceInputSchema.parse(raw), plan = await this.load(request.input, signal);
    const source = plan.manifest.sources.find(s => s.id === request.sourceId);
    if (!source) throw Error("GNC.LABEL_IDENTITY_CONFLICT");
    const result = await this.resolveOne(request.input, source, signal), bytes = encode(result);
    if (bytes.length > limit) throw Error("GNC.LABEL_OUTPUT_LIMIT");
    const key = `v3/gnc-label-inputs/${request.input.operationId}/sources/${source.id}.json`;
    await this.evidence.retain(key, bytes, "application/json", signal);
    await this.evidence.publish(key, bytes, "application/json", signal);
    return result;
  }
  private async derive(input: GncLabelInput, signal: AbortSignal) {
    const plan = await this.load(input, signal), sources = [], skipped: string[] = [], documents: LabelCoreInput["fullDocument"][] = [];
    for (const source of plan.manifest.sources) {
      const result = await this.resolveOne(input, source, signal);
      if (result.status === "not_matched") skipped.push(source.id);
      else sources.push(result.source);
      if (input.corePolicy && source.kind === "page") {
        const full = await this.resolve(source, signal);
        if (full.status !== "resolved" || full.source.kind !== "text" || full.source.task.source.kind !== "prepared") throw Error("GNC.LABEL_SOURCE_UNVERIFIED");
        documents.push(full.source.task.source.document);
      }
    }
    if (!sources.length) throw Error("GNC.LABEL_NO_MATCHED_SOURCES");
    const manifest = LabelProductManifestSchema.parse({ operationId: input.operationId, observation: plan.manifest.observation, sources,
      ...(input.evidencePolicy ? { evidencePolicy: input.evidencePolicy } : {}),
      ...(input.corePolicy ? { admission: { policy: "label-packaging/1", comparison: "label-typography/2", documents } } : {}) });
    return GncLabelOutcomeSchema.parse({ status: "prepared", input, evidenceKey: gncLabelKey(input), manifest, skipped });
  }
  async inspect(raw: unknown, signal: AbortSignal) {
    const input = GncLabelInputSchema.parse(raw), bytes = await this.evidence.deps.remote.read(gncLabelKey(input), limit, signal);
    if (!bytes) return null;
    const derived = await this.derive(input, signal), actual = GncLabelOutcomeSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!equal(actual, derived)) throw Error("GNC.LABEL_PLAN_CONFLICT");
    return derived;
  }
  private async prior(input: GncLabelInput) {
    const id = `gncl-review-${sha256(encode(input))}`, raw = await this.evidence.deps.reviews.read(id);
    if (!raw) return null;
    const r = ReviewRecordSchema.parse(raw);
    if (r.reviewId !== id || r.failure.operationId !== input.operationId || r.failure.inputFingerprint !== sha256(encode(input)) ||
      r.failure.stage !== "gnc.label-input" || !equal(r.observation, input.sourcePlan.task.owner) || !equal(r.rawError.details, { input })) throw Error("GNC.REVIEW_UNVERIFIED");
    return GncLabelOutcomeSchema.parse({ status: "review", operationId: input.operationId, reviewId: id, code: r.failure.code, automaticRetry: false });
  }
  async run(raw: unknown, signal: AbortSignal): Promise<GncLabelOutcome> {
    const input = GncLabelInputSchema.parse(raw), e = this.evidence;
    try {
      signal.throwIfAborted(); const previous = await this.prior(input); if (previous) return previous;
      const old = await this.inspect(input, signal); if (old) return old;
      const result = await this.derive(input, signal), bytes = encode(result);
      if (bytes.length > limit) throw Error("GNC.LABEL_OUTPUT_LIMIT");
      await e.retain(gncLabelKey(input), bytes, "application/json", signal);
      await e.publish(gncLabelKey(input), bytes, "application/json", signal);
      const confirmed = await this.inspect(input, signal); if (!confirmed) throw Error("GNC.LABEL_UNCONFIRMED"); return confirmed;
    } catch (error) {
      signal.throwIfAborted();
      const previous = await this.prior(input); if (previous) return previous;
      const message = error instanceof Error ? error.message : "", code = /^(GNC|LABEL_CORE)\.[A-Z_]+$/.test(message) ? message : "GNC.LABEL_UNRESOLVED";
      const id = `gncl-review-${sha256(encode(input))}`, key = `gnc-label-reviews/${id}.json`;
      const r = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: id, occurredAt: new Date().toISOString(), observation: input.sourcePlan.task.owner,
        failure: { schemaVersion: 1, requestId: input.sourcePlan.task.owner.requestId, observationId: input.sourcePlan.task.owner.observationId,
          operationId: input.operationId, inputFingerprint: sha256(encode(input)), stage: "gnc.label-input", category: "PROCESSING", code,
          executionFact: "unknown", evidenceKey: key, blockedBy: null, automaticRetry: false },
        rawError: { name: "GncLabelPreparationFailure", message: code, stack: null, details: { input } }, candidate: null, inspection: { kind: "none" } });
      const keep = AbortSignal.timeout(10000);
      await e.deps.local.create(key, encode(r), "application/json", keep);
      const bytes = await e.deps.local.read(key, limit, keep); if (!bytes) throw Error("GNC.REVIEW_UNVERIFIED");
      const saved = ReviewRecordSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      if (saved.reviewId !== id || !equal(saved.rawError.details, { input })) throw Error("GNC.REVIEW_UNVERIFIED");
      try { await e.deps.reviews.append(saved); } catch { /* Same-ID readback only. */ }
      if (!equal(await e.deps.reviews.read(id), saved)) throw Error("GNC.REVIEW_UNVERIFIED");
      return (await this.prior(input))!;
    }
  }
}
