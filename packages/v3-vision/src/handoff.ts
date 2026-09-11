import { z } from "zod";
import { VisionRecordSchema, VisionTaskSchema, VisionInputSchema, Sha256Schema, VisionCandidateSchema, LabelImageCandidateSchema,
  type VisionRecord, type VisionTask, type ArtifactRef } from "@crawl-automation/v3-contracts";
import { verifyBytes, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { digest } from "./keywords.js";
import { decodeVisionResult } from "./protocol.js";

export interface VisionRegistry {
  read(operationId: string): Promise<VisionRecord | null>;
  register(record: VisionRecord): Promise<void>;
}
type QueryPort = { query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
/** Fail before a model turn if this database has not explicitly admitted the new receipt codec. */
export async function assertLabelVisionRegistrySchema(db: QueryPort, protocol: "label-extraction/1"|"label-extraction/2" = "label-extraction/1") {
  const result = await db.query(`SELECT 1 FROM pg_constraint
    WHERE conrelid='public.processing_result'::regclass AND contype='c' AND convalidated
      AND conname='processing_result_codec'
      AND pg_get_constraintdef(oid) LIKE '%vision-result/2%'
      AND pg_get_constraintdef(oid) LIKE $1`,[`%${protocol}%`]);
  if (result.rows.length !== 1) throw Error("VISION.SCHEMA_MIGRATION_REQUIRED");
}
const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
const hash = (r: unknown) => digest(JSON.stringify(VisionRecordSchema.parse(r)));
const responseSchema = z.strictObject({ fingerprint: Sha256Schema, raw: z.string().max(250000), sha256: Sha256Schema });
const intentSchema = z.strictObject({ fingerprint: Sha256Schema, nonce: z.uuid(), input: VisionInputSchema });
export const visionFingerprint = (task: VisionTask) => digest(JSON.stringify(["vision-input/1", task.input, task.configFingerprint]));

export class PostgresVisionRegistry implements VisionRegistry {
  constructor(private readonly db: QueryPort) {}
  async read(id: string) {
    const row = (await this.db.query("SELECT record,record_hash FROM public.processing_result WHERE operation_id=$1", [id])).rows[0];
    if (!row) return null;
    const record = VisionRecordSchema.parse(row.record);
    if (record.input.operationId !== id || hash(record) !== row.record_hash) throw Error("VISION.RESULT_INTEGRITY");
    return record;
  }
  async register(raw: VisionRecord) {
    const record = VisionRecordSchema.parse(raw), fingerprint = hash(record);
    await this.db.query("INSERT INTO public.processing_result(operation_id,record_hash,record) VALUES($1,$2,$3::jsonb) ON CONFLICT(operation_id) DO NOTHING",
      [record.input.operationId, fingerprint, JSON.stringify(record)]);
    const saved = await this.read(record.input.operationId);
    if (!saved || hash(saved) !== fingerprint) throw Error("VISION.RESULT_CONFLICT");
  }
}

/** Registration is not product ingestion. Inspection never uploads, registers, or calls a model. */
export class VisionHandoff {
  constructor(readonly local: ObjectStore, readonly remote: ObjectStore, readonly registry: VisionRegistry,
    readonly storageId: string, private readonly verifyOcr: (task: VisionTask, signal: AbortSignal) => Promise<void>) {}
  private prefix(task: VisionTask) { return `v3/vision/${task.input.operationId}`; }
  private async evidence(task: VisionTask, signal: AbortSignal, allowLocalResponse = false) {
    await this.verifyOcr(task, signal);
    const image = task.input.selection.image;
    const source = await this.remote.read(image.objectKey, 16 * 1024 * 1024, signal);
    if (!source) throw Error("VISION.SOURCE_NOT_DURABLE");
    verifyBytes(image, source, 16 * 1024 * 1024);
    const prefix = this.prefix(task);
    const intentBytes = await this.remote.read(`${prefix}/intent.json`, 1024 * 1024, signal);
    const remoteBytes = await this.remote.read(`${prefix}/response.json`, 2 * 1024 * 1024, signal);
    const bytes = remoteBytes ?? (allowLocalResponse ? await this.local.read(`${prefix}/response.json`, 2 * 1024 * 1024, signal) : null);
    if (!intentBytes || !bytes) throw Error("VISION.HANDOFF_INCOMPLETE");
    const intent = intentSchema.parse(decode(intentBytes)), response = responseSchema.parse(decode(bytes));
    if (intent.fingerprint !== visionFingerprint(task) || response.fingerprint !== intent.fingerprint ||
      JSON.stringify(intent.input) !== JSON.stringify(task.input) || digest(response.raw) !== response.sha256)
      throw Error("VISION.EVIDENCE_CONFLICT");
    const output = decodeVisionResult(task.input, response.raw);
    if (output.status === "review") throw Error("VISION.RESULT_NOT_ACCEPTED");
    return { bytes, output, responseDurable: remoteBytes !== null };
  }
  /** Explicit recovery only; verifies original intent, OCR, image, fingerprint and raw response. No provider is reachable. */
  async inspectRecovery(raw: VisionTask, signal: AbortSignal) {
    const task = VisionTaskSchema.parse(raw), saved = await this.inspect(task, signal);
    if (saved) return { computed: true, durable: true, registered: true };
    const facts = await this.evidence(task, signal, true);
    return { computed: true, durable: facts.responseDurable, registered: false };
  }
  async uploadRecoveredResponse(raw: VisionTask, signal: AbortSignal) {
    const task = VisionTaskSchema.parse(raw), facts = await this.evidence(task, signal, true);
    if (!facts.responseDurable) await this.put(this.remote, `${this.prefix(task)}/response.json`, facts.bytes, signal);
  }
  private prepare(task: VisionTask, bytes: Uint8Array, status: "candidate" | "partial") {
    const version = task.input.extractionProtocol ? 2 : 1;
    const owner = task.input.selection.observation, prefix = this.prefix(task);
    const ref = (name: string, data: Uint8Array): ArtifactRef => ({ schemaVersion: 1,
      artifactId: `vision-${name}-${digest(task.input.operationId)}`, observationId: owner.observationId,
      sourceId: owner.sourceId, listingId: owner.listingId, variantId: owner.variantId,
      kind: "result-json", mediaType: "application/json", objectKey: `${prefix}/${name}.json`, sha256: digest(data), byteSize: data.length,
      producer: { operationId: task.input.operationId, module: "codex.vision", implementationVersion: `vision/${version}` } });
    const result = ref("response", bytes);
    const completion = encode({ schemaVersion: version, codec: `vision-completion/${version}`, ...task, status, result, complete: true });
    return { record: VisionRecordSchema.parse({ schemaVersion: version, codec: `vision-result/${version}`, storageId: this.storageId,
      ...task, status, result, completion: ref("completion", completion) }), completion };
  }
  private async put(store: ObjectStore, key: string, bytes: Uint8Array, signal: AbortSignal) {
    try { await store.create(key, bytes, "application/json", signal); } catch { /* Verify once, never repeat PUT. */ }
    const saved = await store.read(key, bytes.length, signal);
    if (!saved || digest(saved) !== digest(bytes)) throw Error("VISION.HANDOFF_UNKNOWN");
  }
  async inspect(raw: VisionTask, signal: AbortSignal) {
    const task = VisionTaskSchema.parse(raw), record = await this.registry.read(task.input.operationId);
    if (!record) return null;
    if (record.configFingerprint !== task.configFingerprint || JSON.stringify(record.input) !== JSON.stringify(task.input) || record.storageId !== this.storageId)
      throw Error("VISION.RESULT_CONFLICT");
    const { bytes, output } = await this.evidence(task, signal), expected = this.prepare(task, bytes, output.status as "candidate" | "partial");
    if (hash(record) !== hash(expected.record)) throw Error("VISION.RESULT_INTEGRITY");
    const completion = await this.remote.read(record.completion.objectKey, 1024 * 1024, signal);
    if (!completion) throw Error("VISION.RESULT_NOT_DURABLE");
    verifyBytes(record.completion, completion, 1024 * 1024);
    if (digest(completion) !== digest(expected.completion)) throw Error("VISION.RESULT_INTEGRITY");
    return record;
  }
  /** Read-only downstream adapter: reverify registration and remote evidence before exposing a candidate. */
  async readCandidate(raw: VisionTask, signal: AbortSignal) {
    if (VisionTaskSchema.parse(raw).input.extractionProtocol) throw Error("VISION.LEGACY_PROTOCOL_UNSUPPORTED");
    const { record, candidate } = await this.readResultCandidate(raw, signal);
    return { record, candidate: VisionCandidateSchema.parse(candidate) };
  }
  async readLabelCandidate(raw: VisionTask, signal: AbortSignal) {
    if (!VisionTaskSchema.parse(raw).input.extractionProtocol) throw Error("VISION.LABEL_PROTOCOL_REQUIRED");
    const { record, candidate } = await this.readResultCandidate(raw, signal);
    return { record, candidate: LabelImageCandidateSchema.parse(candidate) };
  }
  private async readResultCandidate(raw: VisionTask, signal: AbortSignal) {
    const task = VisionTaskSchema.parse(raw), record = await this.inspect(task, signal);
    if (!record) throw Error("VISION.RESULT_NOT_REGISTERED");
    const { output } = await this.evidence(task, signal);
    return { record, candidate: output.candidate };
  }

  /** Only the initial successful execution calls complete; redelivery must inspect only. */
  async complete(raw: VisionTask, signal: AbortSignal) {
    const task = VisionTaskSchema.parse(raw), prior = await this.inspect(task, signal);
    if (prior) return prior;
    const { bytes, output } = await this.evidence(task, signal), p = this.prepare(task, bytes, output.status as "candidate" | "partial");
    const key = `${this.prefix(task)}/registration.json`;
    await this.put(this.local, key, encode(p.record), signal);
    await this.put(this.local, p.record.completion.objectKey, p.completion, signal);
    await this.put(this.remote, p.record.completion.objectKey, p.completion, signal);
    await this.registry.register(p.record);
    const saved = await this.inspect(task, signal);
    if (!saved) throw Error("VISION.HANDOFF_UNKNOWN");
    return saved;
  }
}
