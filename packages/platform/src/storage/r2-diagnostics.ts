export function r2Status(error: unknown): number | undefined {
  if (error && typeof error === "object" && "$metadata" in error) {
    return (error.$metadata as { httpStatusCode?: number }).httpStatusCode;
  }
  return undefined;
}

const token = (value: unknown, pattern: RegExp) =>
  typeof value === "string" && pattern.test(value) ? value : undefined;

/** Exclude SDK messages, endpoints, headers, credentials and arbitrary causes. */
export function r2Diagnostics(raw: unknown): Record<string, unknown> {
  const error = raw as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown; requestId?: unknown };
  } | null;
  const status = error?.$metadata?.httpStatusCode;
  const fields = {
    name: token(error?.name, /^[A-Za-z]{1,50}$/),
    code: token(error?.code, /^[A-Z_0-9]{1,50}$/),
    status: typeof status === "number" ? status : undefined,
    requestId: token(error?.$metadata?.requestId, /^[a-zA-Z0-9-]{1,128}$/),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
