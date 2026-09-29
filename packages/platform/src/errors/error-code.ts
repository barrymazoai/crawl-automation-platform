const CODE = /^[A-Z][A-Z0-9_]*\.[A-Z0-9_.]{1,90}$/;

/**
 * The code an error carries: `AppError.code`, or the `code` field older modules set on their own error classes
 * (ChannelError, NetworkError, ScraperApiError). Null when the error has no code.
 */
export function errorCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CODE.test(code) ? code : null;
}
