import { safeDiagnosticText, safeObjectKey } from "@crawl-automation/platform/errors/summary";
import type { ReviewRequest } from "./pipeline-model.js";

/**
 * The bounded reason a failed product carries into its Review, read from the failure's own details through at most
 * eight wrappers: a channel check name (Amazon), a DTC variant/scope/capture reason and code, evidence keys and flags.
 * Diagnostics only — it never decides whether a product passes; a pure projection of serialized failure data that
 * changes only existing Review activity arguments.
 */
export function failureDetails(error: unknown): ReviewRequest["details"] {
  let current = error;
  let message;
  // Activity/child failure wrappers may nest; never recurse through arbitrary error payloads.
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const failure = diagnosticRecord(current);
    const details = diagnosticRecord(
      Array.isArray(failure.details) ? failure.details[0] : failure.details,
    );
    const result = diagnosticRecord(details.result);
    const evidence = details.evidenceKeys ?? details.evidence;
    const summary = {
      check: diagnosticString(details.check),
      reason: diagnosticReason(details),
      code: diagnosticString(details.code ?? result.reasonCode),
      verification: diagnosticString(details.verification),
      flags: diagnosticStrings(details.flags),
      evidenceKeys: objectKeys(
        Array.isArray(evidence) ? evidence : [diagnosticRecord(evidence).objectKey],
      ),
    };
    if (Object.values(summary).some((value) => value !== undefined)) {
      return summary;
    }
    message = diagnosticString(failure.message) ?? message;
    current = failure.cause;
  }
  return message ? { reason: message } : undefined;
}

function diagnosticReason(details: Record<string, unknown>) {
  return diagnosticString(
    details.reason ??
      diagnosticRecord(details.decision).reason ??
      diagnosticRecord(details.result).summary,
  );
}

function diagnosticRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Failure text can quote pages, URLs or headers: redact before it reaches an immutable Review. */
function diagnosticString(value: unknown) {
  return safeDiagnosticText(value);
}

function diagnosticStrings(value: unknown) {
  const strings = Array.isArray(value)
    ? value.slice(0, 20).flatMap((entry) => safeDiagnosticText(entry) ?? [])
    : [];
  return strings.length ? strings : undefined;
}

export function objectKeys(value: unknown) {
  const keys = Array.isArray(value)
    ? value.slice(0, 20).flatMap((entry) => safeObjectKey(entry) ?? [])
    : [];
  return keys.length ? keys : undefined;
}
