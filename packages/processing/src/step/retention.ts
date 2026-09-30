/** How long storing a result or a Review may take after the service answered, even if the task was cancelled. */
export const RETENTION_MS = 10_000;

/** A signal for keeping a result or a Review; it ignores the task's own cancellation. */
export function retentionSignal(): AbortSignal {
  return AbortSignal.timeout(RETENTION_MS);
}
