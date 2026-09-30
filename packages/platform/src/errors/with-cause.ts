/** Preserve the original reason when a typed error factory cannot accept ErrorOptions. */
export function withCause<T extends Error>(error: T, cause: unknown): T {
  if (error !== cause) {
    error.cause = cause;
  }
  return error;
}
