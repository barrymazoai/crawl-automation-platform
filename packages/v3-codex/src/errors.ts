// Legacy text codes stay stable; vision translates them at its boundary.
export class CodexError extends Error {
  /** What Codex itself said went wrong, redacted and bounded. The code alone could not tell a rate limit from an
   * expired login from a dropped stream, which left a two-hour fleet-wide failure undiagnosable (2026-09-19). */
  constructor(readonly code: string, readonly executionFact: "not_executed" | "executed" | "unknown" = "unknown",
    readonly detail?: string) {
    super(code); this.name = "TextError";
  }
}
export { CodexError as TextError };

const SECRET = /\b(sk-[A-Za-z0-9_-]{8,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})|(Bearer|Basic)\s+\S+|(api[_-]?key|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi;

/** A Codex error payload (`error` notification or failed turn) as one redacted line. Never throws. */
export function describeCodexError(value: unknown): string | undefined {
  if (value == null) return undefined;
  let text: string;
  try { if (typeof value === "string") text = value;
  else if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    const parts = [v.message, v.codexErrorInfo, v.additionalDetails]
      .filter(p => p != null).map(p => typeof p === "string" ? p : JSON.stringify(p));
    text = parts.length ? parts.join(" | ") : JSON.stringify(value);
  } else return undefined;
  } catch { return 'Codex returned an unreadable error'; }
  const clean = text.replace(SECRET, (_m, key, scheme, name, sep) =>
    key ? "[redacted]" : scheme ? `${scheme} [redacted]` : `${name}${sep}[redacted]`).replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 500) : undefined;
}
