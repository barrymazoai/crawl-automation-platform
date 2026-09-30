import { recordRecovery } from "@crawl-automation/platform";
import { isDeepStrictEqual } from "node:util";
import type { ObjectStore } from "@crawl-automation/platform";
import type { VisionRecord, VisionTask } from "@crawl-automation/v3-contracts";
import { noResult, type ResultFacts, type ResultRegistry } from "../results/result-kind.js";
import { decodeRecord, encodeJson, recordHash } from "../results/result-record.js";
import { writeOnce } from "../results/write-once.js";
import type { StepResults } from "../step/processing-step.js";
import { visionFailure } from "./vision-errors.js";
import type { VisionEvidence } from "./vision-evidence.js";
import {
  prepareVisionRecord,
  visionKeys,
  visionLimits,
  visionRecordCodec,
} from "./vision-files.js";

/** What a vision call hands on to be stored: its stored answer's bytes and the decoded status. */
export interface VisionOutput {
  bytes: Uint8Array;
  status: "candidate" | "partial";
}

export interface VisionResultsDeps {
  local: ObjectStore;
  remote: ObjectStore;
  /** Null for a cloud-mode worker: it keeps results locally and in R2 but never touches the ledger. */
  registry: ResultRegistry<VisionRecord> | null;
  evidence: VisionEvidence;
  storageId: string;
}

export type VisionFacts = ResultFacts<VisionRecord>;

/**
 * A vision task's result files and ledger entry. The answer is kept locally, then in R2, the completion is written
 * once, and the record is registered in the shared `processing_result` ledger, each read back.
 */
export class VisionResults implements StepResults<VisionTask, VisionOutput, VisionRecord> {
  constructor(protected readonly deps: VisionResultsDeps) {}

  async inspect(task: VisionTask, signal: AbortSignal): Promise<VisionFacts> {
    const { saved, record } = await this.storedRecord(task, signal);
    if (!record) {
      return noResult;
    }
    const answer = await this.deps.evidence.verify(task, { allowLocal: !saved }, signal);
    const expected = prepareVisionRecord(task, answer, this.deps.storageId);
    if (recordHash(visionRecordCodec, record) !== recordHash(visionRecordCodec, expected.record)) {
      throw visionFailure("VISION.RESULT_INTEGRITY");
    }
    const key = record.completion.objectKey;
    const inR2 = await this.sameBytes(
      this.deps.remote,
      { key, bytes: expected.completion },
      signal,
    );
    const kept = await this.sameBytes(this.deps.local, { key, bytes: expected.completion }, signal);
    const artifactDurable = answer.inR2 && inR2;
    if (saved && !artifactDurable) {
      throw visionFailure("VISION.RESULT_NOT_DURABLE");
    }
    return { computedLocal: kept, artifactDurable, resultRegistered: !!saved, record };
  }

  /** Keeps the completion and the ledger record locally; the answer itself was kept when it arrived. */
  async capture(task: VisionTask, output: VisionOutput, signal: AbortSignal): Promise<void> {
    const prepared = prepareVisionRecord(task, output, this.deps.storageId);
    const journal = await this.journal(task, signal);
    if (
      journal &&
      recordHash(visionRecordCodec, journal) !== recordHash(visionRecordCodec, prepared.record)
    ) {
      throw visionFailure("VISION.RESULT_CONFLICT", "executed");
    }
    const completion = { key: prepared.record.completion.objectKey, bytes: prepared.completion };
    await this.put(this.deps.local, completion, signal);
    if (!journal) {
      const entry = { key: visionKeys.registration(task), bytes: encodeJson(prepared.record) };
      await this.put(this.deps.local, entry, signal);
    }
  }

  /** Uploads the answer and the completion if R2 lacks them; only files already kept locally are uploaded. */
  async uploadMissing(task: VisionTask, signal: AbortSignal): Promise<VisionFacts> {
    const facts = await this.inspect(task, signal);
    if (facts.artifactDurable) {
      return facts;
    }
    if (!facts.record) {
      throw visionFailure("VISION.HANDOFF_PENDING", "executed");
    }
    for (const key of [visionKeys.response(task), facts.record.completion.objectKey]) {
      await this.uploadKept(key, signal);
    }
    return this.inspect(task, signal);
  }

  /** Registers a durable result, then reads it back; a lost acknowledgement is only read back. */
  async register(task: VisionTask, signal: AbortSignal): Promise<VisionFacts> {
    const facts = await this.inspect(task, signal);
    if (facts.resultRegistered) {
      return facts;
    }
    if (!facts.artifactDurable || !facts.record) {
      throw visionFailure("VISION.HANDOFF_PENDING", "executed");
    }
    const registry = this.deps.registry;
    if (!registry) {
      throw visionFailure("VISION.REGISTRY_UNAVAILABLE", "executed");
    }
    // The ledger's answer is not trusted either way: the read-back below decides (a conflict included).
    await registry.register(facts.record).catch((error: unknown) => {
      recordRecovery(error, { operation: "vision.register" });
    });
    const after = await this.inspect(task, signal);
    if (!after.resultRegistered) {
      throw visionFailure("VISION.HANDOFF_UNKNOWN", "executed");
    }
    return after;
  }

  /** Writes once and reads back; different bytes under the key mean storing it cannot be confirmed. */
  protected put(
    store: ObjectStore,
    entry: { key: string; bytes: Uint8Array },
    signal: AbortSignal,
  ) {
    const mismatch = () => visionFailure("VISION.HANDOFF_UNKNOWN", "executed");
    return writeOnce(store, entry, { signal, mismatch });
  }

  /** The ledger's record and this worker's journal record must agree, and belong to this task and storage. */
  private async storedRecord(task: VisionTask, signal: AbortSignal) {
    const registry = this.deps.registry;
    const saved = registry ? await registry.read(task.input.operationId) : null;
    signal.throwIfAborted();
    const journal = await this.journal(task, signal);
    if (
      saved &&
      journal &&
      recordHash(visionRecordCodec, saved) !== recordHash(visionRecordCodec, journal)
    ) {
      throw visionFailure("VISION.RESULT_CONFLICT");
    }
    const record = saved ?? journal;
    if (record && !this.isOwn(record, task)) {
      throw visionFailure("VISION.RESULT_CONFLICT");
    }
    return { saved, record };
  }

  private isOwn(record: VisionRecord, task: VisionTask): boolean {
    return (
      record.configFingerprint === task.configFingerprint &&
      isDeepStrictEqual(record.input, task.input) &&
      record.storageId === this.deps.storageId
    );
  }

  private async journal(task: VisionTask, signal: AbortSignal): Promise<VisionRecord | null> {
    const key = visionKeys.registration(task);
    const bytes = await this.deps.local.read(key, visionLimits.completionBytes, signal);
    return bytes ? decodeRecord(visionRecordCodec, bytes) : null;
  }

  private async sameBytes(
    store: ObjectStore,
    entry: { key: string; bytes: Buffer },
    signal: AbortSignal,
  ) {
    const saved = await store.read(entry.key, visionLimits.completionBytes, signal);
    if (saved && !entry.bytes.equals(Buffer.from(saved))) {
      throw visionFailure("VISION.RESULT_INTEGRITY");
    }
    return saved !== null;
  }

  private async uploadKept(key: string, signal: AbortSignal): Promise<void> {
    if (await this.deps.remote.read(key, visionLimits.responseBytes, signal)) {
      return;
    }
    const bytes = await this.deps.local.read(key, visionLimits.responseBytes, signal);
    if (!bytes) {
      throw visionFailure("VISION.HANDOFF_PENDING", "executed");
    }
    await this.put(this.deps.remote, { key, bytes }, signal);
  }
}
