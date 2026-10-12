/** Preserve the original reason when a typed error factory cannot accept ErrorOptions. */
export function withCause<T extends Error>(error: T, cause: unknown): T {
  if (error !== cause) {
    error.cause = cause;
  }
  return error;
}

/**
 * Reads back after a write whose own failure is `writeCause`. When the read also throws, its error and code stay as
 * they are and the write failure becomes its cause (unless it already has one), so neither is lost.
 */
export async function readBackAfterWrite<T>(
  read: () => Promise<T>,
  writeCause: unknown,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (writeCause !== undefined && error instanceof Error && error.cause === undefined) {
      withCause(error, writeCause);
    }
    throw error;
  }
}
