// Legacy text codes stay stable; vision translates them at its boundary.
export class CodexError extends Error {
  constructor(readonly code: string, readonly executionFact: "not_executed" | "executed" | "unknown" = "unknown") {
    super(code); this.name = "TextError";
  }
}
export { CodexError as TextError };
