import { sha256 } from "@crawl-automation/v3-artifacts";
import {
  TextOutputSchema,
  parseTextInput,
  type TextInput,
  type TextOutput,
} from "@crawl-automation/v3-contracts";
import { textFailure } from "../errors.js";
import type { TextFacts } from "../ports.js";
import { assertOutputMatchesSource } from "./stored-output.js";
import {
  MAX_COMPLETION_BYTES,
  MAX_RESULT_BYTES,
  isOwnOutput,
  decodeJson,
  hashRecord,
  hashText,
  prepareRecord,
  textKeys,
  type PreparedRecord,
} from "./text-record.js";
import type { TextResults, TextResultsDeps } from "./text-results.js";

/**
 * Finishing results that were computed but not fully stored or registered: from this worker's retained output, or
 * (on the receipt side) from the bytes a cloud worker left in R2. Never calls the model, never re-uploads upstream.
 */
export class TextResultRecovery {
  constructor(
    private readonly results: TextResults,
    private readonly deps: TextResultsDeps,
  ) {}

  async inspectRecovery(input: TextInput, signal: AbortSignal) {
    const facts = await this.results.inspect(input, signal);
    if (facts.record) {
      return {
        computed: facts.computedLocal,
        durable: facts.artifactDurable,
        registered: facts.resultRegistered,
      };
    }
    await this.retainedOutput(input, signal);
    return { computed: true, durable: false, registered: false };
  }

  async uploadRecoveredResponse(input: TextInput, signal: AbortSignal): Promise<void> {
    const facts = await this.results.inspect(input, signal);
    if (!facts.record) {
      await this.results.capture(input, await this.retainedOutput(input, signal), signal);
    }
    await this.results.uploadMissing(input, signal);
  }

  /** Rebuilds the record from the remote result bytes, requires the remote manifest to match, then registers. */
  async registerFromRemote(inputRaw: unknown, signal: AbortSignal): Promise<TextFacts> {
    const input = parseTextInput(inputRaw, hashText);
    const before = await this.results.inspect(input, signal);
    if (before.resultRegistered) {
      return before;
    }
    const registry = this.deps.registry;
    if (!registry) {
      throw textFailure("TEXT.REGISTRY_UNAVAILABLE", "executed");
    }
    const prepared = await this.remotePrepared(input, signal);
    if (before.record && hashRecord(before.record) !== hashRecord(prepared.record)) {
      throw textFailure("TEXT.RESULT_CONFLICT", "executed");
    }
    await this.results.keepLocally(prepared, { journal: !before.record }, signal);
    // inspect() re-verifies quotes, decoding and source durability against the remote copy.
    const verified = await this.results.inspect(input, signal);
    if (!verified.artifactDurable || !verified.record) {
      throw textFailure("TEXT.HANDOFF_INCOMPLETE", "executed");
    }
    await registry.register(verified.record);
    const after = await this.results.inspect(input, signal);
    if (!after.resultRegistered) {
      throw textFailure("TEXT.HANDOFF_UNKNOWN", "executed");
    }
    return after;
  }

  private async remotePrepared(input: TextInput, signal: AbortSignal): Promise<PreparedRecord> {
    const { remote, storageId } = this.deps;
    const prefix = textKeys.prefix(input);
    const resultBytes = await remote.read(`${prefix}/result.json`, MAX_RESULT_BYTES, signal);
    const manifestBytes = await remote.read(
      `${prefix}/completion.json`,
      MAX_COMPLETION_BYTES,
      signal,
    );
    signal.throwIfAborted();
    if (!resultBytes || !manifestBytes) {
      throw textFailure("TEXT.HANDOFF_INCOMPLETE", "executed");
    }
    let prepared: PreparedRecord;
    try {
      prepared = prepareRecord(input, TextOutputSchema.parse(decodeJson(resultBytes)), storageId);
    } catch {
      throw textFailure("TEXT.RESULT_INTEGRITY", "executed");
    }
    if (
      sha256(prepared.bytes) !== sha256(resultBytes) ||
      sha256(prepared.manifest) !== sha256(manifestBytes)
    ) {
      throw textFailure("TEXT.RESULT_INTEGRITY", "executed");
    }
    return prepared;
  }

  /** Only a retained typed output counts; a raw response alone lacks the original provider details. */
  private async retainedOutput(input: TextInput, signal: AbortSignal): Promise<TextOutput> {
    parseTextInput(input, hashText);
    const key = `${textKeys.prefix(input)}/result.json`;
    const bytes = await this.deps.local.read(key, MAX_RESULT_BYTES, signal);
    if (!bytes) {
      throw textFailure("TEXT.HANDOFF_INCOMPLETE", "executed");
    }
    const output = TextOutputSchema.parse(decodeJson(bytes));
    if (!isOwnOutput(input, output)) {
      throw textFailure("TEXT.RESULT_CONFLICT");
    }
    const source = await this.deps.evidence.resolve(input, signal);
    assertOutputMatchesSource(input, output, { text: source.text });
    return output;
  }
}
