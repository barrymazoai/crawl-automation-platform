// Moved to @crawl-automation/processing (text/results). The old workers keep the old constructor and method names.
import { PostgresTextRegistry as TextRegistryRepository } from "@crawl-automation/adapters/text-registry";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import type { TextInput } from "@crawl-automation/v3-contracts";
import {
  TextResultRecovery,
  TextResults,
  textKeys,
  type TextSource,
} from "@crawl-automation/processing";
import type { QueryPort, TextRegistry } from "./ports.js";

export { hashText, textRecord } from "@crawl-automation/processing";

/** The adapters repository, over the old workers' pg-style pool (`query` returns `{ rows }`). */
export class PostgresTextRegistry extends TextRegistryRepository {
  constructor(db: QueryPort) {
    super({
      query: async <Row extends object>(sql: string, values?: readonly unknown[]) =>
        (await db.query(sql, values ? [...values] : undefined)).rows as Row[],
    });
  }
}

export class TextHandoff extends TextResults {
  private readonly recovery: TextResultRecovery;

  constructor(
    readonly local: ObjectStore,
    readonly remote: ObjectStore,
    readonly registry: TextRegistry | null,
    readonly evidence: TextSource,
    readonly storageId: string,
  ) {
    const deps = { local, remote, registry, evidence, storageId };
    super(deps);
    this.recovery = new TextResultRecovery(this, deps);
  }

  journalKey(input: TextInput) {
    return textKeys.journal(input);
  }

  responseKey(input: TextInput) {
    return textKeys.response(input);
  }

  inspectRecovery(input: TextInput, signal: AbortSignal) {
    return this.recovery.inspectRecovery(input, signal);
  }

  uploadRecoveredResponse(input: TextInput, signal: AbortSignal) {
    return this.recovery.uploadRecoveredResponse(input, signal);
  }

  registerFromRemote(input: unknown, signal: AbortSignal) {
    return this.recovery.registerFromRemote(input, signal);
  }
}
