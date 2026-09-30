/** Node timers reject with ABORT_ERR when their owning service is stopped normally. */
export function ignoreAbort(error: unknown): void {
  if (error && typeof error === "object" && "code" in error && error.code === "ABORT_ERR") {
    return;
  }
  throw error;
}
