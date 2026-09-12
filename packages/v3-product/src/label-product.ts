import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { LabelProductJoinSchema, LabelCollectionInputSchema, LabelCollectedProductSchema, ReviewRecordSchema,
  type PackagingFacts, type LabelProductJoin, type LabelCollectedProduct, type ProductImageOutcome, type ProductWorkflowOutcome, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { sha256, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { visionFingerprint } from "@crawl-automation/v3-vision";
import { mergeLabelProduct, type VerifiedLabelSource } from "./label-merge.js";
const LIMIT = 8 * 1024 * 1024, encode = (v: unknown) => Buffer.from(JSON.stringify(v));
type Stores = { local: ObjectStore; remote: ObjectStore; reviews: { append(r: ReviewRecord): Promise<unknown>; read(id: string): Promise<ReviewRecord | null> } };
type Source = LabelProductJoin["manifest"]["sources"][number];
export const labelAssemblyKey = (input: LabelProductJoin) => `v3/label-products/${input.manifest.operationId}/assembly.json`;
function canonical(raw: unknown) {
  const input = LabelProductJoinSchema.parse(raw), sort = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  input.manifest.sources.sort(sort); input.states.sort(sort);
  input.manifest.admission?.documents.sort((a, b) => a.objectKey < b.objectKey ? -1 : a.objectKey > b.objectKey ? 1 : 0);
  return input;
}
const verify = (a: Uint8Array | null, b: Uint8Array) => { if (!a || sha256(a) !== sha256(b)) throw Error("LABEL_PRODUCT.HANDOFF_UNVERIFIED"); };
async function retain(local: ObjectStore, key: string, bytes: Uint8Array, signal: AbortSignal) {
  if (bytes.length > LIMIT) throw Error("LABEL_PRODUCT.OUTPUT_LIMIT");
  await local.create(key, bytes, "application/json", signal); verify(await local.read(key, LIMIT, signal), bytes);
}
/** Shared write-ahead claim. An unknown claim is never taken over automatically. */
async function claim(remote: ObjectStore, key: string, hash: string, signal: AbortSignal) {
  if (await remote.read(key, 65536, signal)) throw Error("LABEL_PRODUCT.HANDOFF_PENDING");
  const bytes = encode({ hash, nonce: randomUUID() });
  try { if (await remote.create(key, bytes, "application/json", signal) !== "created") throw Error(); }
  catch { throw Error("LABEL_PRODUCT.HANDOFF_PENDING"); }
  verify(await remote.read(key, 65536, signal), bytes);
}
async function review(deps: Stores, input: LabelProductJoin, codes: string[], key: string, stage: "assembly" | "collect", candidate: unknown, existingCollection?: {operationId:string;observationId:string;recordHash:string}): Promise<ProductImageOutcome> {
  const observation = input.manifest.observation, signal = AbortSignal.timeout(10000);
  const stable = ["label-image-first/2","label-image-first/3","label-image-first/4","label-image-first/5"].includes(input.manifest.evidencePolicy??"");
  const identity = stable ? sha256(encode([stage, input, codes, key, candidate, ...(existingCollection ? [existingCollection] : [])])) : randomUUID();
  let r = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: `label-${identity}`, occurredAt: new Date().toISOString(), observation,
    failure: { schemaVersion: 1, requestId: observation.requestId, observationId: observation.observationId, operationId: input.manifest.operationId,
      inputFingerprint: sha256(encode(input)), stage: `product.label.${stage}`, category: stage === "assembly" ? "VALIDATION" : "INGEST",
      code: codes[0], executionFact: "unknown", evidenceKey: key, blockedBy: null, automaticRetry: false },
    rawError: { name: "LabelProductReview", message: codes[0], stack: null, details: { input, codes, ...(existingCollection ? {existingCollection,versionPolicy:"retain-first/1"} : {}) } },
    candidate: candidate ? { schema: stage === "assembly" ? (input.manifest.admission ? "label-product-assembly/2" : "label-product-assembly/1") : (input.manifest.admission ? "collected-product/4" : "collected-product/3"), value: candidate } : null,
    inspection: { kind: "none" } });
  // New-policy Review is an immutable result too. A cold Worker must return the
  // existing receipt, not create another Review merely because its cache is empty.
  if (stable) {
    const reviewKey = `v3/label-products/${input.manifest.operationId}/reviews/${identity}.json`;
    let bytes = await deps.remote.read(reviewKey, LIMIT, signal);
    if (!bytes) {
      try { await deps.remote.create(reviewKey, encode(r), "application/json", signal); } catch { /* reconcile by exact readback */ }
      bytes = await deps.remote.read(reviewKey, LIMIT, signal);
    }
    if (!bytes) throw Error("LABEL_PRODUCT.REVIEW_UNVERIFIED");
    const saved = ReviewRecordSchema.parse(JSON.parse(Buffer.from(bytes).toString()));
    if (!equal(saved, { ...r, occurredAt: saved.occurredAt })) throw Error("LABEL_PRODUCT.REVIEW_UNVERIFIED");
    r = saved;
  }
  await retain(deps.local, `label-product-reviews/${r.reviewId}.json`, encode(r), signal);
  try { await deps.reviews.append(r); } catch { /* same-ID verification */ }
  const saved = await deps.reviews.read(r.reviewId);
  if (!saved || !equal(ReviewRecordSchema.parse(saved), r)) throw Error("LABEL_PRODUCT.REVIEW_UNVERIFIED");
  return { status: "review", reviewId: r.reviewId, evidenceKey: key, codes, automaticRetry: false };
}
const errorCode = (e: unknown) => e instanceof Error && /^(LABEL_PRODUCT|LABEL_COLLECTION)\.[A-Z_]+$/.test(e.message) ? e.message : "LABEL_PRODUCT.EVIDENCE_UNRESOLVED";
/** Post-barrier read-only source verification; publication is separate from collection. */
export class LabelProductAssembly {
  constructor(readonly deps: Stores & { readSource(source: Source, signal: AbortSignal): Promise<VerifiedLabelSource>;
    readPackaging?(input: LabelProductJoin["manifest"], signal: AbortSignal): Promise<PackagingFacts> }) {}
  private async compute(input: LabelProductJoin, signal: AbortSignal) {
    const states = new Map(input.states.map(s => [s.id, s]));
    if (states.size !== input.states.length || input.states.some(s => !input.manifest.sources.some(p => p.id === s.id))) throw Error("LABEL_PRODUCT.IDENTITY_CONFLICT");
    if (states.size !== input.manifest.sources.length) throw Error("LABEL_PRODUCT.BARRIER_INCOMPLETE");
    const entries: VerifiedLabelSource[] = [], failures: { id: string; code: string; verifiedExecuted?: boolean }[] = [];
    for (const source of input.manifest.sources) {
      signal.throwIfAborted(); const state = states.get(source.id)!;
      if (state.status === "rejected" || state.status === "not_matched") throw Error("LABEL_PRODUCT.RECEIPT_INVALID");
      if (state.status === "review") {
        const raw = await this.deps.reviews.read(state.reviewId);
        if (!raw) throw Error("LABEL_PRODUCT.REVIEW_UNVERIFIED");
        const r = ReviewRecordSchema.parse(raw), op = source.kind === "text" ? source.task.operationId : source.task.input.operationId;
        const fp = source.kind === "text" ? source.task.inputFingerprint : visionFingerprint(source.task);
        if (r.reviewId !== state.reviewId || r.failure.operationId !== op || r.failure.inputFingerprint !== fp || !equal(r.observation, input.manifest.observation) ||
          !(source.kind === "text" ? ["codex.text", "text.receipt"] : ["codex.vision"]).includes(r.failure.stage)) throw Error("LABEL_PRODUCT.IDENTITY_CONFLICT");
        failures.push({ id: source.id, code: r.failure.code, verifiedExecuted:r.failure.executionFact==="executed" }); continue;
      }
      try {
        const entry = await this.deps.readSource(source, signal);
        if (entry.id !== source.id || entry.kind !== source.kind) throw Error("LABEL_PRODUCT.IDENTITY_CONFLICT");
        entries.push(entry);
      } catch (error) {
        signal.throwIfAborted();
        if (errorCode(error) === "LABEL_PRODUCT.IDENTITY_CONFLICT") throw error;
        failures.push({ id: source.id, code: errorCode(error) });
      }
    }
    let packaging: PackagingFacts | undefined;
    if (input.manifest.admission) {
      if (!this.deps.readPackaging) throw Error("LABEL_PRODUCT.PACKAGING_UNVERIFIED");
      packaging = await this.deps.readPackaging(input.manifest, signal);
    }
    return { input, result: mergeLabelProduct(input.manifest, entries, failures, packaging) };
  }
  async inspectReady(raw: unknown, key: string, signal: AbortSignal) {
    const input = canonical(raw), output = await this.compute(input, signal), expected = encode(output);
    if (key !== labelAssemblyKey(input) || output.result.status !== "ready") throw Error("LABEL_PRODUCT.NOT_READY");
    const bytes = await this.deps.remote.read(key, LIMIT, signal); verify(bytes, expected);
    return { key, bytes: bytes!, output };
  }
  async run(raw: unknown, signal: AbortSignal): Promise<ProductImageOutcome> {
    const input = canonical(raw), key = labelAssemblyKey(input);
    let output: Awaited<ReturnType<LabelProductAssembly["compute"]>> | null = null;
    try {
      output = await this.compute(input, signal); const bytes = encode(output);
      if (bytes.length > LIMIT) throw Error("LABEL_PRODUCT.OUTPUT_LIMIT");
      const prior = await this.deps.remote.read(key, LIMIT, signal);
      if (prior) verify(prior, bytes);
      else {
        const intent = `v3/label-products/${input.manifest.operationId}/assembly-intent.json`;
        if (await this.deps.remote.read(intent, 65536, signal) || await this.deps.local.read(key, LIMIT, signal)) throw Error("LABEL_PRODUCT.HANDOFF_PENDING");
        await retain(this.deps.local, key, bytes, signal); await claim(this.deps.remote, intent, sha256(bytes), signal);
        try { await this.deps.remote.create(key, bytes, "application/json", signal); } catch { /* GET only */ }
        verify(await this.deps.remote.read(key, LIMIT, signal), bytes);
      }
      signal.throwIfAborted();
      if (output.result.status === "ready") return { status: "ready", evidenceKey: key };
    } catch (error) {
      signal.throwIfAborted();
      return review(this.deps, input, [...new Set([...(output?.result.codes ?? []), errorCode(error)])], key, "assembly", output);
    }
    return review(this.deps, input, output.result.codes, key, "assembly", output);
  }
}
export const labelCollectedHash = (raw: unknown) => sha256(encode(LabelCollectedProductSchema.parse(raw)));
export interface LabelCollectedRegistry { read(id: string): Promise<LabelCollectedProduct | null>; append(record: LabelCollectedProduct): Promise<void>;
  readObservation?(observationId:string):Promise<LabelCollectedProduct|null> }
export class PostgresLabelCollectedProducts implements LabelCollectedRegistry {
  constructor(private readonly db: { query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }) {}
  async read(id: string) {
    const row = (await this.db.query("SELECT observation_id,record_hash,record FROM public.collected_product WHERE operation_id=$1", [id])).rows[0];
    if (!row) return null;
    const record = LabelCollectedProductSchema.parse(row.record);
    if (record.operationId !== id || record.observation.observationId !== row.observation_id || labelCollectedHash(record) !== row.record_hash) throw Error("LABEL_COLLECTION.INTEGRITY");
    return record;
  }
  async readObservation(observationId:string){
    const row=(await this.db.query("SELECT operation_id FROM public.collected_product WHERE observation_id=$1",[observationId])).rows[0];
    if(!row)return null;
    const record=await this.read(String(row.operation_id));
    if(!record || record.observation.observationId!==observationId)throw Error("LABEL_COLLECTION.INTEGRITY");
    return record;
  }
  async append(raw: LabelCollectedProduct) {
    const record = LabelCollectedProductSchema.parse(raw), hash = labelCollectedHash(record);
    await this.db.query("INSERT INTO public.collected_product(operation_id,observation_id,record_hash,record) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING",
      [record.operationId, record.observation.observationId, hash, JSON.stringify(record)]);
    const saved = await this.read(record.operationId);
    if (!saved || labelCollectedHash(saved) !== hash) throw Error("LABEL_COLLECTION.CONFLICT");
  }
}
export class CollectLabelProduct {
  constructor(private readonly deps: Stores & { assembly: Pick<LabelProductAssembly, "inspectReady">; registry: LabelCollectedRegistry }) {}
  async run(raw: unknown, signal: AbortSignal): Promise<ProductWorkflowOutcome> {
    const parsed = LabelCollectionInputSchema.parse(raw), input = canonical(parsed.join), key = parsed.evidenceKey;
    let candidate: LabelCollectedProduct | null = null;
    let existingCollection: {operationId:string;observationId:string;recordHash:string}|undefined;
    const checkObservation=async()=>{
      if(!candidate || !this.deps.registry.readObservation)return;
      const existing=await this.deps.registry.readObservation(candidate.observation.observationId);
      if(existing&&existing.operationId!==candidate.operationId){
        existingCollection={operationId:existing.operationId,observationId:existing.observation.observationId,recordHash:labelCollectedHash(existing)};
        throw Error("LABEL_COLLECTION.OBSERVATION_ALREADY_COLLECTED");
      }
    };
    try {
      signal.throwIfAborted();
      const evidence = await this.deps.assembly.inspectReady(input, key, signal), result = evidence.output.result;
      candidate = LabelCollectedProductSchema.parse({ ...(input.manifest.admission ? { schemaVersion: 4, codec: "collected-product/4",
        admissionPolicy: result.admissionPolicy, comparisonPolicy: result.comparisonPolicy, packaging: result.packaging } : { schemaVersion: 3, codec: "collected-product/3" }), operationId: input.manifest.operationId,
        observation: input.manifest.observation, assembly: { objectKey: key, sha256: sha256(evidence.bytes), byteSize: evidence.bytes.length },
        ...(result.evidencePolicy ? { evidencePolicy: result.evidencePolicy } : {}),
        formula: result.formula, otherIngredients: result.otherIngredients, ingredients: result.ingredients, warnings: result.warnings, provenance: result.provenance });
      const hash = labelCollectedHash(candidate), prior = await this.deps.registry.read(candidate.operationId);
      if (prior && labelCollectedHash(prior) !== hash) throw Error("LABEL_COLLECTION.CONFLICT");
      if (!prior) {
        await checkObservation();
        const localKey = `label-collection/${candidate.operationId}.json`, intent = `v3/label-products/${candidate.operationId}/collection-intent.json`;
        if (await this.deps.remote.read(intent, 65536, signal) || await this.deps.local.read(localKey, LIMIT, signal)) throw Error("LABEL_PRODUCT.HANDOFF_PENDING");
        await retain(this.deps.local, localKey, encode(candidate), signal); await claim(this.deps.remote, intent, hash, signal);
        signal.throwIfAborted();
        try { await this.deps.registry.append(candidate); } catch { /* Verify, do not repeat INSERT. */ }
      }
      const saved = await this.deps.registry.read(candidate.operationId);
      if (!saved){await checkObservation();throw Error("LABEL_COLLECTION.REGISTRATION_UNKNOWN");}
      if (labelCollectedHash(saved) !== hash) throw Error("LABEL_COLLECTION.CONFLICT");
      await this.deps.assembly.inspectReady(input, key, signal); signal.throwIfAborted();
      return { status: "collected", operationId: candidate.operationId, observationId: candidate.observation.observationId, recordHash: hash, evidenceKey: key };
    } catch (error) {
      signal.throwIfAborted();
      const result = await review(this.deps, input, [errorCode(error)], key, "collect", candidate, existingCollection);
      if (result.status !== "review") throw Error("LABEL_PRODUCT.REVIEW_UNVERIFIED");
      return result;
    }
  }
}
