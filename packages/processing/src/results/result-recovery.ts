import { sha256 } from "@crawl-automation/platform";
import type { ProcessingInput, ResultFacts, StoredRecord } from "./result-kind.js";
import { noResult } from "./result-kind.js";
import { decodeJson, prepareRecord, recordHash, type PreparedRecord } from "./result-record.js";
import type { ResultStore, ResultStoreDeps } from "./result-store.js";
import { allDurable } from "./stored-result.js";

/**
 * Finishing results that were computed but not fully stored or registered: from this worker's kept output, or from
 * the files a cloud worker left in R2. Never runs the service again and never uploads the evidence it read.
 */
export class ResultRecovery<
  TInput extends ProcessingInput,
  TOutput,
  TRecord extends StoredRecord<TInput>,
> {
  constructor(
    private readonly store: ResultStore<TInput, TOutput, TRecord>,
    private readonly deps: ResultStoreDeps<TInput, TOutput, TRecord>,
  ) {}

  /** Read-only: the record rebuilt from R2 alone, for a worker without a ledger. */
  async inspectRemote(raw: unknown, signal: AbortSignal): Promise<ResultFacts<TRecord>> {
    const input = this.deps.kind.parseInput(raw);
    const prepared = await this.remotePrepared(input, signal);
    if (!prepared) {
      return noResult;
    }
    await this.assertEvidenceDurable(input, prepared, signal);
    return {
      computedLocal: false,
      artifactDurable: true,
      resultRegistered: false,
      record: prepared.record,
    };
  }

  /** Registers what a cloud worker left in R2, after rebuilding and checking every byte of it. */
  async registerFromRemote(raw: unknown, signal: AbortSignal): Promise<ResultFacts<TRecord>> {
    const { kind, registry } = this.deps;
    const input = kind.parseInput(raw);
    const before = await this.store.inspect(input, signal);
    if (before.resultRegistered) {
      return before;
    }
    if (!registry) {
      throw kind.fail("registryUnavailable", "executed");
    }
    const prepared = await this.remotePrepared(input, signal);
    if (!prepared) {
      throw kind.fail("incomplete", "executed");
    }
    if (before.record && recordHash(kind, before.record) !== recordHash(kind, prepared.record)) {
      throw kind.fail("conflict", "executed");
    }
    await this.store.keepLocally(prepared, { journal: !before.record }, signal);
    return this.store.register(input, signal);
  }

  /** What a recovery would find: a stored record, or only this worker's kept output. */
  async inspectRecovery(input: TInput, signal: AbortSignal) {
    const facts = await this.store.inspect(input, signal);
    if (facts.record) {
      return {
        computed: facts.computedLocal,
        durable: facts.artifactDurable,
        registered: facts.resultRegistered,
      };
    }
    await this.keptOutput(input, signal);
    return { computed: true, durable: false, registered: false };
  }

  /** Stores this worker's kept output if it never got a journal entry, then uploads what R2 lacks. */
  async uploadRecovered(input: TInput, signal: AbortSignal): Promise<ResultFacts<TRecord>> {
    const facts = await this.store.inspect(input, signal);
    if (!facts.record) {
      await this.store.capture(input, await this.keptOutput(input, signal), signal);
    }
    return this.store.uploadMissing(input, signal);
  }

  /** The record rebuilt from the R2 result file; the R2 manifest must be byte-identical to the rebuilt one. */
  private async remotePrepared(
    input: TInput,
    signal: AbortSignal,
  ): Promise<PreparedRecord<TRecord> | null> {
    const { kind, remote, storageId } = this.deps;
    const prefix = kind.keys.prefix(input);
    const result = await remote.read(`${prefix}/result.json`, kind.limits.resultBytes, signal);
    const manifest = await remote.read(
      `${prefix}/completion.json`,
      kind.limits.completionBytes,
      signal,
    );
    signal.throwIfAborted();
    if (!result || !manifest) {
      return null;
    }
    let prepared: PreparedRecord<TRecord>;
    try {
      prepared = prepareRecord(kind, { input, output: decodeJson(result) as TOutput, storageId });
    } catch {
      throw kind.fail("integrity", "executed");
    }
    const same =
      sha256(prepared.bytes) === sha256(result) && sha256(prepared.manifest) === sha256(manifest);
    if (!same) {
      throw kind.fail("integrity", "executed");
    }
    return prepared;
  }

  private async assertEvidenceDurable(
    input: TInput,
    prepared: PreparedRecord<TRecord>,
    signal: AbortSignal,
  ): Promise<void> {
    const { kind, remote } = this.deps;
    const evidence = await kind.evidence(input, signal);
    if (!(await allDurable(kind, { remote, refs: evidence.refs }, signal))) {
      throw kind.fail("sourceNotDurable", "executed");
    }
    evidence.check(kind.parseOutput(input, decodeJson(prepared.bytes)));
  }

  /** Only a kept typed output counts; a raw service answer alone lacks the provider details. */
  private async keptOutput(input: TInput, signal: AbortSignal): Promise<TOutput> {
    const { kind, local } = this.deps;
    kind.parseInput(input);
    const key = `${kind.keys.prefix(input)}/result.json`;
    const bytes = await local.read(key, kind.limits.resultBytes, signal);
    if (!bytes) {
      throw kind.fail("incomplete", "executed");
    }
    const output = kind.parseOutput(input, decodeJson(bytes));
    (await kind.evidence(input, signal)).check(output);
    return output;
  }
}
