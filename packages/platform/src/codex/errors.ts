import type { CodexErrorCode } from "../errors/codex-errors.js";

export type CodexExecutionFact = "not_executed" | "executed" | "unknown";

/** Retains the legacy error shape, including arbitrary codes read from saved failure records. */
export class CodexError extends Error {
  constructor(
    readonly code: string,
    readonly executionFact: CodexExecutionFact = "unknown",
    readonly detail?: string,
  ) {
    super(code);
    this.name = "TextError";
  }
}

/** New failures use the platform registry; replayed records retain their own codes. */
export function codexFailure(
  code: CodexErrorCode,
  executionFact: CodexExecutionFact = "unknown",
  detail?: string,
): CodexError {
  return new CodexError(code, executionFact, detail);
}
