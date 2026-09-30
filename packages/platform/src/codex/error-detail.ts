const SECRET = new RegExp(
  /\b(sk-[A-Za-z0-9_-]{8,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})/.source +
    /|(Bearer|Basic)\s+\S+/.source +
    /|(api[_-]?key|token|secret|password|authorization)/.source +
    /(["']?\s*[:=]\s*["']?)[^\s"',}]+/.source,
  "gi",
);

function errorText(value: object): string {
  const fields = value as Record<string, unknown>;
  const parts = [fields.message, fields.codexErrorInfo, fields.additionalDetails]
    .filter((part) => part != null)
    .map((part) => (typeof part === "string" ? part : JSON.stringify(part)));
  return parts.length ? parts.join(" | ") : JSON.stringify(value);
}

function redactSecret(...matches: string[]): string {
  const [, key, scheme, name, separator] = matches;
  if (key) {
    return "[redacted]";
  }
  return scheme ? `${scheme} [redacted]` : `${name}${separator}[redacted]`;
}

/** A remote error as a bounded, redacted line. Unreadable payloads never escape. */
export function describeCodexError(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  let text: string;
  try {
    if (typeof value === "string") {
      text = value;
    } else if (typeof value === "object") {
      text = errorText(value);
    } else {
      return undefined;
    }
  } catch (error) {
    // Retain the serialization failure through the same redaction boundary, never log the raw payload.
    text = error instanceof Error ? `${error.name}: ${error.message}` : "Unreadable Codex error";
  }
  const clean = text.replace(SECRET, redactSecret).replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 500) : undefined;
}
