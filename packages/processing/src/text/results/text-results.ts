import { verifyBytes, sha256 } from "@crawl-automation/v3-artifacts";
import type { ObjectStore } from "@crawl-automation/platform";
import {
  TextOutputSchema,
  parseTextInput,
  type TextRecord,
  type TextInput,
  type TextOutput,
} from "@crawl-automation/v3-contracts";
import { textFailure } from "../errors.js";
import { claimTextIntent } from "../step/text-intent.js";
import type { TextFacts, TextResultRegistry, TextSource } from "../ports.js";
import { allDurable, isDurable } from "./source-durability.js";
import { assertOutputMatchesSource, holdsVerifiedRecord } from "./stored-output.js";
import {
  MAX_RESULT_BYTES,
  assertOwnOutput,
  decodeJson,
  encodeJson,
  hashRecord,
  hashText,
  prepareRecord,
  textKeys,
  textRecord,
  type PreparedRecord,
} from "./text-record.js";
import { textLimits } from "../limits.js";

export interface TextResultsDeps {
  local: ObjectStore;
  remote: ObjectStore;
  /** Null for a cloud-mode worker: it keeps evidence locally and remotely but never touches the ledger. */
  registry: TextResultRegistry | null;
  evidence: TextSource;
  storageId: string;
}

/** A text task's result files and ledger entry: stored once, read back, never written twice. */
export class TextResults {
  constructor(private readonly deps: TextResultsDeps) {}

  /** The task's verified source text. */
  resolveSource(input: TextInput, signal: AbortSignal) {
    return this.deps.evidence.resolve(input, signal);
  }

  /** Claims the only right to call the model for this task (see claimTextIntent). */
  claimIntent(input: TextInput, nodeId: string, signal: AbortSignal): Promise<void> {
    const claim = { input, storageId: this.deps.storageId, nodeId };
    return claimTextIntent(this.deps.remote, claim, signal);
  }

  async retainResponse(input: TextInput, rawResponse: string): Promise<void> {
    const bytes = encodeJson({ input, rawResponse });
    await this.put(
      this.deps.local,
      { key: textKeys.response(input), bytes },
      AbortSignal.timeout(textLimits.retentionMs),
    );
  }

  /** Keeps a verified output locally: result, completion manifest, then the journal entry. */
  async capture(input: TextInput, output: TextOutput, signal: AbortSignal): Promise<void> {
    parseTextInput(input, hashText);
    const parsed = TextOutputSchema.parse(output);
    assertOwnOutput(input, parsed);
    const source = await this.deps.evidence.resolve(input, signal);
    assertOutputMatchesSource(input, parsed, { text: source.text, fact: "executed" });
    const prepared = prepareRecord(input, output, this.deps.storageId);
    await this.keepLocally(prepared, { journal: true }, signal);
  }

  /** Result, completion manifest, then (unless one is already kept) the journal entry: each written once. */
  async keepLocally(prepared: PreparedRecord, options: { journal: boolean }, signal: AbortSignal) {
    const { record } = prepared;
    const local = this.deps.local;
    await this.put(local, { key: record.result.objectKey, bytes: prepared.bytes }, signal);
    await this.put(local, { key: record.completion.objectKey, bytes: prepared.manifest }, signal);
    if (options.journal) {
      await this.put(
        local,
        { key: textKeys.journal(record.input), bytes: encodeJson(record) },
        signal,
      );
    }
  }

  async inspect(input: TextInput, signal: AbortSignal): Promise<TextFacts> {
    const { saved, record } = await this.storedRecord(input, signal);
    if (!record) {
      return {
        computedLocal: false,
        artifactDurable: false,
        resultRegistered: false,
        record: null,
      };
    }
    const source = await this.deps.evidence.resolve(input, signal);
    const check = { input, record, sourceText: source.text };
    const computedLocal = await this.verifiedLocally(check, signal);
    const remoteHolds = await holdsVerifiedRecord(this.deps.remote, check, signal);
    const sourcesDurable = await allDurable(this.deps.remote, source.refs, signal);
    const artifactDurable = remoteHolds && sourcesDurable;
    if (saved && !artifactDurable) {
      throw textFailure("TEXT.RESULT_NOT_DURABLE");
    }
    return { computedLocal, artifactDurable, resultRegistered: !!saved, record };
  }

  /** The ledger's record and this worker's journal record must agree, and belong to this task and storage. */
  private async storedRecord(input: TextInput, signal: AbortSignal) {
    const saved = this.deps.registry ? await this.deps.registry.read(input.operationId) : null;
    const journal = await this.deps.local.read(textKeys.journal(input), MAX_RESULT_BYTES, signal);
    const localRecord = journal ? textRecord(decodeJson(journal)) : null;
    if (saved && localRecord && hashRecord(saved) !== hashRecord(localRecord)) {
      throw textFailure("TEXT.RESULT_CONFLICT");
    }
    const record = saved ?? localRecord;
    if (record) {
      this.assertOwnRecord(record, input);
    }
    return { saved, record };
  }

  private assertOwnRecord(record: TextRecord, input: TextInput): void {
    const foreign = JSON.stringify(record.input) !== JSON.stringify(input);
    if (foreign || record.storageId !== this.deps.storageId) {
      throw textFailure("TEXT.RESULT_CONFLICT");
    }
  }

  /** A damaged local copy only means it is not computed here; the remote copy decides. */
  private async verifiedLocally(
    check: Parameters<typeof holdsVerifiedRecord>[1],
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      return await holdsVerifiedRecord(this.deps.local, check, signal);
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }

  /** Uploads the result files the remote store lacks; the source evidence must already be durable. */
  async uploadMissing(input: TextInput, signal: AbortSignal): Promise<void> {
    const facts = await this.inspect(input, signal);
    if (facts.artifactDurable) {
      return;
    }
    if (!facts.computedLocal || !facts.record) {
      throw textFailure("TEXT.HANDOFF_INCOMPLETE", "executed");
    }
    const source = await this.deps.evidence.resolve(input, signal);
    for (const ref of source.refs) {
      if (!(await isDurable(this.deps.remote, ref, signal))) {
        throw textFailure("TEXT.SOURCE_NOT_DURABLE", "executed");
      }
    }
    for (const ref of [facts.record.result, facts.record.completion]) {
      const saved = await this.deps.remote.read(ref.objectKey, ref.byteSize, signal);
      if (saved) {
        verifyBytes(ref, saved, MAX_RESULT_BYTES);
        continue;
      }
      const bytes = await this.deps.local.read(ref.objectKey, ref.byteSize, signal);
      if (!bytes) {
        throw textFailure("TEXT.HANDOFF_INCOMPLETE", "executed");
      }
      await this.put(this.deps.remote, { key: ref.objectKey, bytes }, signal);
    }
  }

  async register(input: TextInput, signal: AbortSignal): Promise<TextFacts> {
    const facts = await this.inspect(input, signal);
    if (!facts.artifactDurable || !facts.record) {
      throw textFailure("TEXT.HANDOFF_INCOMPLETE", "executed");
    }
    if (!this.deps.registry) {
      throw textFailure("TEXT.REGISTRY_UNAVAILABLE", "executed");
    }
    if (!facts.resultRegistered) {
      await this.deps.registry.register(facts.record);
    }
    const after = await this.inspect(input, signal);
    if (!after.resultRegistered) {
      throw textFailure("TEXT.HANDOFF_UNKNOWN", "executed");
    }
    return after;
  }

  /** Writes once, then reads back; an unknown acknowledgement is verified, never repeated. */
  async put(
    store: ObjectStore,
    entry: { key: string; bytes: Uint8Array },
    signal: AbortSignal,
  ): Promise<void> {
    const { key, bytes } = entry;
    try {
      await store.create(key, bytes, "application/json", signal);
    } catch {
      // The read-back below decides.
    }
    const saved = await store.read(key, bytes.length, signal);
    if (!saved || sha256(saved) !== sha256(bytes)) {
      throw textFailure("TEXT.HANDOFF_UNKNOWN", "executed");
    }
  }
}
