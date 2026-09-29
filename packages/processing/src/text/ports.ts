import type { TextCompatibility, TextInput, TextRecord } from "@crawl-automation/v3-contracts";
import type { SourceText } from "./evidence/text-evidence.js";

/** The model client: one call per task, no retries, no fallback model. */
export interface TextModel {
  readonly provider: string;
  readonly supported: TextCompatibility;
  /** Business execution boundary. Internal Codex model requests are not business retries. */
  readonly policy: {
    executionRetries: 0;
    internalModelRequests: "no-retries";
    toolAccess: "runtime-profile";
    modelFallback: false;
    networkSwitching: false;
  };
  interpret(
    request: { operationId: string; prompt: string; outputSchema: object },
    signal: AbortSignal,
  ): Promise<string>;
  close(): Promise<void>;
}

/** The result ledger (`processing_result`). A cloud worker has none. */
export interface TextResultRegistry {
  read(operationId: string): Promise<TextRecord | null>;
  register(record: TextRecord): Promise<void>;
}

/** Where a task's source text comes from. */
export interface TextSource {
  resolve(input: TextInput, signal: AbortSignal): Promise<SourceText>;
}

/** What is known about a task's result: computed here, durable in R2, registered in the ledger. */
export interface TextFacts {
  computedLocal: boolean;
  artifactDurable: boolean;
  resultRegistered: boolean;
  record: TextRecord | null;
}
