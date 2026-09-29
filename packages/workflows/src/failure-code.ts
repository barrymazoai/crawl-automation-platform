/** The error code a failure carries: an Activity's ApplicationFailure type, or the failure's own type. */
export function failureCode(error: unknown): string | null {
  const own = (error as { type?: unknown } | null)?.type;
  const cause = (error as { cause?: { type?: unknown } } | null)?.cause?.type;
  const code = typeof cause === "string" ? cause : typeof own === "string" ? own : null;
  return code && /^[A-Z][A-Z0-9_]*\.[A-Z0-9_.]{1,90}$/.test(code) ? code : null;
}
