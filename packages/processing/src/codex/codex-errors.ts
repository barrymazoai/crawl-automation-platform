import { withCause } from "@crawl-automation/platform";
import { CodexError } from "@crawl-automation/platform";
import type { ExecutionFact } from "../step/step-failure.js";

/** Vision names Codex failures `VISION.CODEX_*` where text says `TEXT.CODEX_*`, keeping fact and detail. */
export function asVisionCodexError(error: CodexError): CodexError {
  return withCause(
    new CodexError(error.code.replace(/^TEXT\./, "VISION."), error.executionFact, error.detail),
    error,
  );
}

/** Whether the model ran, as a Codex failure says; null for any other error. */
export function codexFactOf(error: unknown): ExecutionFact | null {
  return error instanceof CodexError ? error.executionFact : null;
}

/** What Codex itself said went wrong, redacted; undefined for any other error. */
export function codexDetailOf(error: unknown): string | undefined {
  return error instanceof CodexError ? error.detail : undefined;
}
