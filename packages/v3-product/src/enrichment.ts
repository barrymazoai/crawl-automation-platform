import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EnrichmentInputSchema, EnrichmentCandidateSchema, EnrichmentRecordSchema, LabelCollectedProductSchema, ReviewRecordSchema,
  ENRICHMENT_PROTOCOL, type EnrichmentOutcome, type EnrichmentRecord, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { sha256 } from "@crawl-automation/v3-artifacts";

type Collected = z.infer<typeof LabelCollectedProductSchema>;
export interface EnrichmentDependencies {
  provider: { provider: string; interpret(request: { operationId: string; prompt: string; outputSchema: object }, signal: AbortSignal): Promise<string> };
  /** `collected_product` by operation id. */
  collections: { read(operationId: string): Promise<unknown | null> };
  /** Title/url of the capture that produced the observation, when retained. */
  captures: { describe(observationId: string): Promise<{ title: string | null; url: string | null } | null> };
  registry: { read(enrichmentId: string): Promise<unknown | null>; register(record: EnrichmentRecord): Promise<void> };
  publication: { publish(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal): Promise<unknown> };
  reviews: { append(record: ReviewRecord): Promise<unknown>; read(reviewId: string): Promise<ReviewRecord | null> };
}
export class EnrichmentError extends Error {
  constructor(readonly code: "ENRICH.COLLECTION_MISSING" | "ENRICH.OUTPUT_INVALID" | "ENRICH.PROVIDER_FAILED" | "ENRICH.REGISTRATION_UNKNOWN" | "ENRICH.CONFLICT",
    readonly executionFact: "not_executed" | "executed" | "unknown", options?: { cause?: unknown }) { super(code, options); this.name = "EnrichmentError"; }
}
const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
/** Content-only view of the label: field texts without citations, so the hash follows what the label says, not where it was read. */
function content(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(content);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    // A label field is {text, ...provenance}: keep the printed text only, whatever the provenance keys are called.
    if (typeof o.text === "string") return o.text;
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, content(v)]));
  }
  return value;
}
export const formulaContentHash = (c: Pick<Collected, "formula" | "otherIngredients" | "ingredients">) =>
  sha256(encode({ formula: content(c.formula), otherIngredients: content(c.otherIngredients), ingredients: content(c.ingredients) }));
export const enrichmentIdFor = (listingId: string, formulaHash: string) => sha256(encode([listingId, formulaHash, ENRICHMENT_PROTOCOL]));

export function enrichmentPrompt(input: { title: string | null; url: string | null; listingId: string; label: unknown }) {
  return [
    "You are normalizing one dietary-supplement product for a product database.",
    "Use ONLY the label content, title and URL below. Do not invent facts, do not add marketing language, do not guess health claims that the label or ingredients do not support.",
    "Return exactly one JSON object matching the provided schema, nothing else.",
    "Field rules:",
    "- unifiedName: brand + product name + strength (if printed) + dosage form + count/size, in English, e.g. \"Carlyle Vitamin D3 5000 IU Softgels, 400 Count\".",
    "- baseName: the product name WITHOUT count, size, flavor or pack quantity, so that all sizes/flavors of the same product share it.",
    "- form: the dosage form from the serving unit or title; use \"unknown\" if not determinable.",
    "- variant.count: units per container if printed; variant.size: net content with unit if printed (e.g. 16 oz, 500 g); variant.flavor and variant.strength only if printed.",
    "- healthFunctions: up to 12 short English phrases (2-5 words) describing what this product is for, derived from label claims and well-established roles of the listed ingredients (e.g. \"immune support\", \"bone health\", \"joint support\"). Empty array if nothing can be stated.",
    "- confidence: 0-1 for the whole answer. notes: at most one sentence on anything ambiguous, else null.",
    "",
    "Product:",
    JSON.stringify({ listingId: input.listingId, title: input.title, url: input.url, label: input.label }, null, 1),
  ].join("\n");
}

export class ProductEnrichment {
  constructor(private readonly deps: EnrichmentDependencies) {}
  async run(raw: unknown, signal: AbortSignal): Promise<EnrichmentOutcome> {
    const input = EnrichmentInputSchema.parse(raw);
    const stored = await this.deps.collections.read(input.collectionOperationId);
    if (!stored) throw new EnrichmentError("ENRICH.COLLECTION_MISSING", "not_executed");
    const collection = LabelCollectedProductSchema.parse(stored);
    if (collection.operationId !== input.collectionOperationId) throw new EnrichmentError("ENRICH.CONFLICT", "not_executed");
    const listingId = collection.observation.listingId, formulaHash = formulaContentHash(collection), enrichmentId = enrichmentIdFor(listingId, formulaHash);
    const existing = await this.deps.registry.read(enrichmentId);
    if (existing) {
      const record = EnrichmentRecordSchema.parse(existing);
      if (record.enrichmentId !== enrichmentId || record.listingId !== listingId || record.formulaHash !== formulaHash) throw new EnrichmentError("ENRICH.CONFLICT", "not_executed");
      return { status: "registered", enrichmentId, reused: true, candidate: record.candidate };
    }
    const capture = await this.deps.captures.describe(collection.observation.observationId);
    const label = content({ formula: collection.formula, otherIngredients: collection.otherIngredients, ingredients: collection.ingredients });
    const prompt = enrichmentPrompt({ title: capture?.title ?? null, url: capture?.url ?? null, listingId, label });
    const fact: { value: "not_executed" | "executed" | "unknown" } = { value: "not_executed" };
    try {
      signal.throwIfAborted();
      fact.value = "unknown";
      let response: string;
      try { response = await this.deps.provider.interpret({ operationId: `enrich-${enrichmentId.slice(0, 32)}`, prompt, outputSchema: z.toJSONSchema(EnrichmentCandidateSchema) }, signal); }
      catch (error) { throw new EnrichmentError("ENRICH.PROVIDER_FAILED", "unknown", { cause: error }); }
      fact.value = "executed";
      let candidate;
      try { candidate = EnrichmentCandidateSchema.parse(JSON.parse(response)); } catch { throw new EnrichmentError("ENRICH.OUTPUT_INVALID", "executed"); }
      const evidenceKey = `v3/product-enrichment/${enrichmentId}.json`;
      const record = EnrichmentRecordSchema.parse({ schemaVersion: 1, codec: "product-enrichment/1", enrichmentId, protocol: ENRICHMENT_PROTOCOL, listingId, formulaHash,
        collectionOperationId: collection.operationId, observation: collection.observation, provider: this.deps.provider.provider, createdAt: new Date().toISOString(),
        input: { title: capture?.title ?? null, url: capture?.url ?? null, promptSha256: sha256(Buffer.from(prompt)) }, candidate, evidenceKey });
      await this.deps.publication.publish(evidenceKey, encode(record), "application/json", signal);
      try { await this.deps.registry.register(record); } catch { throw new EnrichmentError("ENRICH.REGISTRATION_UNKNOWN", "executed"); }
      const saved = await this.deps.registry.read(enrichmentId);
      if (!saved || sha256(encode(EnrichmentRecordSchema.parse(saved))) !== sha256(encode(record))) throw new EnrichmentError("ENRICH.REGISTRATION_UNKNOWN", "executed");
      return { status: "registered", enrichmentId, reused: false, candidate };
    } catch (error) {
      if (signal.aborted) throw error;
      const code = error instanceof EnrichmentError ? error.code : "ENRICH.UNCLASSIFIED";
      const reviewId = `enrich-${randomUUID()}`, key = `v3/product-enrichment/reviews/${reviewId}.json`;
      const review = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId, occurredAt: new Date().toISOString(),
        failure: { schemaVersion: 1, requestId: collection.observation.requestId, observationId: collection.observation.observationId, operationId: collection.operationId,
          inputFingerprint: sha256(Buffer.from(prompt)), stage: "product.enrich", category: "PROCESSING", code, executionFact: fact.value, evidenceKey: key, blockedBy: null, automaticRetry: false },
        observation: collection.observation, rawError: { name: error instanceof Error ? error.name : "Error", message: code, stack: null, details: { code, enrichmentId, formulaHash } },
        candidate: null, inspection: { kind: "none" } });
      await this.deps.publication.publish(key, encode(review), "application/json", AbortSignal.timeout(20000));
      try { await this.deps.reviews.append(review); } catch { /* read-back decides */ }
      if (!(await this.deps.reviews.read(reviewId))) throw error;
      return { status: "review", reviewId, code };
    }
  }
}
