import type { CodexError } from "@crawl-automation/v3-codex";

/**
 * What differs between the models that share the Codex client (text, vision): the prefix of their working
 * directories, the input kinds the model must accept, and how they name failures.
 */
export interface CodexModelProfile {
  workspace: "execution-" | "vision-";
  modalities: readonly ("text" | "image")[];
  /** The model's name for a Codex failure; text keeps Codex's own codes. */
  renameError(error: CodexError): CodexError;
  /** The model's failure for a private config it cannot use. */
  privateConfig(): Error;
  /** The model's failure for a call after close. */
  closed(): Error;
}
