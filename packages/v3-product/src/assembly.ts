import { randomUUID } from "node:crypto";
import { ProductImageJoinSchema, KeywordResultSchema, ReviewRecordSchema,
  type ProductImageOutcome, type ProductImageJoin, type ReviewRecord } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { digest, keywordKey, type RegisteredOcrEvidence, type VisionHandoff } from "@crawl-automation/v3-vision";
import { mergeProductImages, type VerifiedImageCandidate } from "./merge.js";
class ProductReviewError extends Error { constructor() { super("PRODUCT.REVIEW_UNVERIFIED"); } }

/** Runs only after the Workflow barrier. No model, retries, ingestion or waiting for upstream work. */
export class ProductImageAssembly {
  constructor(private readonly deps: { local: ObjectStore; remote: ObjectStore;
    ocr: Pick<RegisteredOcrEvidence, "verifiedText">; vision: Pick<VisionHandoff, "readCandidate">;
    reviews: { append(record: ReviewRecord): Promise<{ reviewId: string }> } }) {}
  async run(raw: unknown, signal: AbortSignal): Promise<ProductImageOutcome> {
    const input = ProductImageJoinSchema.parse(raw);
    try { return await this.execute(input, signal); }
    catch (error) {
      if (error instanceof ProductReviewError) throw error;
      const allowed = ["PRODUCT.IDENTITY_CONFLICT", "PRODUCT.BARRIER_INCOMPLETE", "PRODUCT.HANDOFF_PENDING", "PRODUCT.HANDOFF_UNVERIFIED", "PRODUCT.OUTPUT_LIMIT"];
      const code = error instanceof Error && allowed.includes(error.message) ? error.message : "PRODUCT.ASSEMBLY_UNRESOLVED";
      return this.review(input, [code], `v3/products/${input.manifest.operationId}/assembly.json`, false, AbortSignal.timeout(10000));
    }
  }
  private async compute(input: ProductImageJoin, signal: AbortSignal) {
    const { manifest, images } = input, candidates: VerifiedImageCandidate[] = [], codes = new Set<string>();
    const ids = new Set<string>();
    for (const r of images) {
      if (ids.has(r.imageId) || !manifest.imageIds.includes(r.imageId)) throw Error("PRODUCT.IDENTITY_CONFLICT");
      ids.add(r.imageId);
    }
    if (ids.size !== manifest.imageIds.length) throw Error("PRODUCT.BARRIER_INCOMPLETE");
    for (const r of images) {
      if (r.status === "review") { codes.add(r.code); continue; }
      try {
        const selection = r.keyword.selection;
        if (r.imageId !== selection.image.artifactId || JSON.stringify(selection.observation) !== JSON.stringify(manifest.observation) ||
          (r.status === "not_matched") !== (selection.status === "not_matched") || r.keyword.evidenceKey !== keywordKey(selection))
          throw Error("PRODUCT.IDENTITY_CONFLICT");
        const saved = await this.deps.remote.read(r.keyword.evidenceKey, 1024 * 1024, signal);
        if (!saved || JSON.stringify(KeywordResultSchema.parse(JSON.parse(Buffer.from(saved).toString()))) !== JSON.stringify(selection)) throw Error("SCREEN.EVIDENCE_MISMATCH");
        await this.deps.ocr.verifiedText(selection, signal);
        if (r.status === "registered") {
          if (r.task.configFingerprint !== manifest.configFingerprint || JSON.stringify(r.task.input.selection) !== JSON.stringify(selection)) throw Error("PRODUCT.IDENTITY_CONFLICT");
          candidates.push(await this.deps.vision.readCandidate(r.task, signal));
        }
      } catch { codes.add("PRODUCT.EVIDENCE_UNRESOLVED"); }
    }
    if (!codes.size && images.every(r => r.status === "not_matched")) codes.add("SCREEN.NO_LABEL_EVIDENCE");
    const merged = mergeProductImages(manifest, candidates);
    merged.codes.forEach(c => codes.add(c));
    return { schemaVersion: 1, input, result: { ...merged, status: codes.size ? "review" : "ready", codes: [...codes].sort() } };
  }
  /** Collection cannot trust an Activity receipt alone: recompute from registered source evidence and compare remote bytes. */
  async inspectReady(raw: ProductImageJoin, evidenceKey: string, signal: AbortSignal) {
    const input = ProductImageJoinSchema.parse(raw), output = await this.compute(input, signal);
    const key = `v3/products/${input.manifest.operationId}/assembly.json`, expected = Buffer.from(JSON.stringify(output));
    if (key !== evidenceKey || output.result.status !== "ready" || !output.result.formula || !output.result.ingredients.length)
      throw Error("COLLECTION.NOT_READY");
    const bytes = await this.deps.remote.read(key, 8 * 1024 * 1024, signal);
    if (!bytes || digest(bytes) !== digest(expected)) throw Error("COLLECTION.EVIDENCE_UNVERIFIED");
    return { output, key, bytes };
  }
  private async execute(input: ProductImageJoin, signal: AbortSignal): Promise<ProductImageOutcome> {
    const { manifest } = input, output = await this.compute(input, signal), codes = new Set(output.result.codes);
    const key = `v3/products/${manifest.operationId}/assembly.json`, bytes = Buffer.from(JSON.stringify(output));
    if (bytes.length > 8 * 1024 * 1024) throw Error("PRODUCT.OUTPUT_LIMIT");
    const verify = (b: Uint8Array | null) => { if (!b || digest(b) !== digest(bytes)) throw Error("PRODUCT.HANDOFF_UNVERIFIED"); };
    const existing = await this.deps.remote.read(key, 8 * 1024 * 1024, signal);
    if (existing) verify(existing);
    else {
      if (await this.deps.local.read(key, 8 * 1024 * 1024, signal)) throw Error("PRODUCT.HANDOFF_PENDING");
      await this.deps.local.create(key, bytes, "application/json", signal);
      verify(await this.deps.local.read(key, 8 * 1024 * 1024, signal));
      try { await this.deps.remote.create(key, bytes, "application/json", signal); } catch { /* read-only verification */ }
      verify(await this.deps.remote.read(key, 8 * 1024 * 1024, signal));
    }
    if (!codes.size) return { status: "ready", evidenceKey: key };
    return this.review(input, [...codes].sort(), key, true, signal);
  }
  private async review(input: ProductImageJoin, codes: string[], key: string, published: boolean, signal: AbortSignal): Promise<ProductImageOutcome> {
    try { return await this.appendReview(input, codes, key, published, signal); }
    catch { throw new ProductReviewError(); }
  }
  private async appendReview(input: ProductImageJoin, codes: string[], key: string, published: boolean, signal: AbortSignal): Promise<ProductImageOutcome> {
    const { manifest, images } = input;
    const review = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: `product-${randomUUID()}`, occurredAt: new Date().toISOString(),
      failure: { schemaVersion: 1, requestId: manifest.observation.requestId, observationId: manifest.observation.observationId,
        operationId: manifest.operationId, inputFingerprint: digest(JSON.stringify(input)), stage: "product.images", category: "VALIDATION",
        code: codes[0], executionFact: published ? "executed" : "unknown", evidenceKey: key, blockedBy: null, automaticRetry: false },
      observation: manifest.observation, rawError: { name: "ProductImageReview", message: "Image-path assembly requires review", stack: null,
        details: { codes, images } }, candidate: published ? { schema: "product-images-ref/1", value: { evidenceKey: key } } : null, inspection: { kind: "none" } });
    const reviewKey = `product-reviews/${review.reviewId}.json`, reviewBytes = Buffer.from(JSON.stringify(review));
    await this.deps.local.create(reviewKey, reviewBytes, "application/json", signal);
    const saved = await this.deps.local.read(reviewKey, 8 * 1024 * 1024, signal);
    if (!saved || digest(saved) !== digest(reviewBytes)) throw Error("PRODUCT.REVIEW_UNVERIFIED");
    const receipt = await this.deps.reviews.append(review);
    return { status: "review", evidenceKey: key, reviewId: receipt.reviewId, codes, automaticRetry: false };
  }
}
