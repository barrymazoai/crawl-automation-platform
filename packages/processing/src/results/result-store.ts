import { isDeepStrictEqual } from "node:util";
import type { ObjectStore } from "@crawl-automation/platform";
import type {
  ProcessingInput,
  ResultFacts,
  ResultKind,
  ResultRegistry,
  StoredRecord,
} from "./result-kind.js";
import { noResult } from "./result-kind.js";
import {
  decodeRecord,
  encodeJson,
  prepareRecord,
  recordHash,
  type PreparedRecord,
} from "./result-record.js";
import { allDurable, holdsVerifiedRecord, type StoredCheck } from "./stored-result.js";
import { writeOnce } from "./write-once.js";

export interface ResultStoreDeps<
  TInput extends ProcessingInput,
  TOutput,
  TRecord extends StoredRecord<TInput>,
> {
  kind: ResultKind<TInput, TOutput, TRecord>;
  local: ObjectStore;
  remote: ObjectStore;
  /** Null for a cloud-mode worker: it keeps results locally and in R2 but never touches the ledger. */
  registry: ResultRegistry<TRecord> | null;
  storageId: string;
}

/**
 * A processing result's files and ledger entry, for every kind of result: kept locally, uploaded to R2, then
 * registered. Each file is written once and read back; nothing is written twice.
 */
export class ResultStore<
  TInput extends ProcessingInput,
  TOutput,
  TRecord extends StoredRecord<TInput>,
> {
  constructor(protected readonly deps: ResultStoreDeps<TInput, TOutput, TRecord>) {}

  /** Keeps a checked output locally: result, completion manifest, then the journal entry. */
  async capture(input: TInput, output: TOutput, signal: AbortSignal): Promise<void> {
    const { kind, storageId } = this.deps;
    kind.parseInput(input);
    const evidence = await kind.evidence(input, signal);
    evidence.check(kind.parseOutput(input, output), "executed");
    const prepared = prepareRecord(kind, { input, output, storageId });
    const journal = await this.journalRecord(input, signal);
    if (journal && recordHash(kind, journal) !== recordHash(kind, prepared.record)) {
      throw kind.fail("conflict", "executed");
    }
    await this.keepLocally(prepared, { journal: !journal }, signal);
  }

  /** Result, completion manifest, then (unless one is already kept) the journal entry: each written once. */
  async keepLocally(
    prepared: PreparedRecord<TRecord>,
    options: { journal: boolean },
    signal: AbortSignal,
  ): Promise<void> {
    const { record } = prepared;
    await this.put(
      this.deps.local,
      { key: record.result.objectKey, bytes: prepared.bytes },
      signal,
    );
    const completion = { key: record.completion.objectKey, bytes: prepared.manifest };
    await this.put(this.deps.local, completion, signal);
    if (options.journal) {
      const journal = { key: this.deps.kind.keys.journal(record.input), bytes: encodeJson(record) };
      await this.put(this.deps.local, journal, signal);
    }
  }

  async inspect(input: TInput, signal: AbortSignal): Promise<ResultFacts<TRecord>> {
    const { kind, local, remote } = this.deps;
    const { saved, record } = await this.storedRecord(input, signal);
    if (!record) {
      return noResult;
    }
    const evidence = await kind.evidence(input, signal);
    const check = { input, record, evidence };
    const computedLocal = await this.verifiedLocally({ ...check, store: local }, signal);
    const remoteHolds = await holdsVerifiedRecord(kind, { ...check, store: remote }, signal);
    const sourcesDurable = await allDurable(kind, { remote, refs: evidence.refs }, signal);
    const artifactDurable = remoteHolds && sourcesDurable;
    if (saved && !artifactDurable) {
      throw kind.fail("registeredNotDurable");
    }
    return { computedLocal, artifactDurable, resultRegistered: !!saved, record };
  }

  /** Uploads the result files R2 lacks; the evidence they were computed from must already be in R2. */
  async uploadMissing(input: TInput, signal: AbortSignal): Promise<ResultFacts<TRecord>> {
    const { kind, local, remote } = this.deps;
    const facts = await this.inspect(input, signal);
    if (facts.artifactDurable) {
      return facts;
    }
    if (!facts.computedLocal || !facts.record) {
      throw kind.fail("incomplete", "executed");
    }
    const evidence = await kind.evidence(input, signal);
    if (!(await allDurable(kind, { remote, refs: evidence.refs }, signal))) {
      throw kind.fail("sourceNotDurable", "executed");
    }
    for (const ref of [facts.record.result, facts.record.completion]) {
      if (await allDurable(kind, { remote, refs: [ref] }, signal)) {
        continue;
      }
      const bytes = await local.read(ref.objectKey, ref.byteSize, signal);
      if (!bytes) {
        throw kind.fail("incomplete", "executed");
      }
      await this.put(remote, { key: ref.objectKey, bytes }, signal);
    }
    return this.inspect(input, signal);
  }

  /** Registers a durable result in the ledger, then reads it back; a lost acknowledgement is only read back. */
  async register(input: TInput, signal: AbortSignal): Promise<ResultFacts<TRecord>> {
    const { kind, registry } = this.deps;
    const facts = await this.inspect(input, signal);
    if (facts.resultRegistered) {
      return facts;
    }
    if (!facts.artifactDurable || !facts.record) {
      throw kind.fail("notYetDurable", "executed");
    }
    if (!registry) {
      throw kind.fail("registryUnavailable", "executed");
    }
    await this.registerRecord(registry, facts.record);
    const after = await this.inspect(input, signal);
    if (!after.resultRegistered) {
      throw kind.fail("unknown", "executed");
    }
    return after;
  }

  /** The ledger's answer is not trusted either way: the read-back that follows decides (a conflict included). */
  protected async registerRecord(registry: ResultRegistry<TRecord>, record: TRecord) {
    try {
      await registry.register(record);
    } catch {
      // Settled by the read-back in register().
    }
  }

  /** Writes once and reads back; different bytes under the key mean storing it cannot be confirmed. */
  protected put(
    store: ObjectStore,
    entry: { key: string; bytes: Uint8Array },
    signal: AbortSignal,
  ) {
    const mismatch = () => this.deps.kind.fail("unknown", "executed");
    return writeOnce(store, entry, { signal, mismatch });
  }

  /** The ledger's record and this worker's journal record must agree, and belong to this task and storage. */
  private async storedRecord(input: TInput, signal: AbortSignal) {
    const { kind, registry } = this.deps;
    const saved = registry ? await registry.read(input.operationId) : null;
    // A cancelled task never reports what the ledger said while it was being cancelled.
    signal.throwIfAborted();
    const journal = await this.journalRecord(input, signal);
    if (saved && journal && recordHash(kind, saved) !== recordHash(kind, journal)) {
      throw kind.fail("conflict");
    }
    const record = saved ?? journal;
    if (
      record &&
      (!isDeepStrictEqual(record.input, input) || record.storageId !== this.deps.storageId)
    ) {
      throw kind.fail("conflict");
    }
    return { saved, record };
  }

  private async journalRecord(input: TInput, signal: AbortSignal): Promise<TRecord | null> {
    const { kind, local } = this.deps;
    const bytes = await local.read(kind.keys.journal(input), kind.limits.resultBytes, signal);
    return bytes ? decodeRecord(kind, bytes) : null;
  }

  /** A damaged local copy only means it is not computed here; the R2 copy decides. */
  private async verifiedLocally(
    check: StoredCheck<TInput, TOutput>,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      return await holdsVerifiedRecord(this.deps.kind, check, signal);
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }
}
