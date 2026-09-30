import { recordRecovery } from "@crawl-automation/platform";

/** Stop waiting without retrying the underlying operation; late resources are closed by their owner. */
export async function abortable<Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> {
  if (signal.aborted) {
    void promise.catch((error: unknown) => recordRecovery(error, { operation: "file.aborted" }));
    signal.throwIfAborted();
  }
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        stop = () => reject(signal.reason);
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) {
          stop();
        }
      }),
    ]);
  } finally {
    if (stop) {
      signal.removeEventListener("abort", stop);
    }
  }
}
