// Moved to @crawl-automation/processing (text/ports). Kept as names for the old workers until they retire.
import type { TextInput } from "@crawl-automation/v3-contracts";

export { CodexError as TextError } from "@crawl-automation/v3-codex";
export type {
  TextFacts,
  TextModel as TextProvider,
  TextResultRegistry as TextRegistry,
} from "@crawl-automation/processing";

/** A `pg`-style query port: the old workers pass a pg pool. */
export interface QueryPort {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type TextRequest = TextInput;
