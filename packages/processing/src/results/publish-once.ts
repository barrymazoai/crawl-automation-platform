import type { AppError, ObjectStore } from "@crawl-automation/platform";
import { writeOnce } from "./write-once.js";

export interface PublishFailures {
  /** Different bytes are already stored under the key, or the read-back differs. */
  mismatch: () => AppError;
  /** A local copy exists without an R2 copy: an earlier publication never finished; it is not retried here. */
  pending: () => AppError;
}

/**
 * Publishes a small JSON evidence file: kept locally, then written once to R2 and read back. An identical R2 copy
 * means it is already published; nothing is ever written twice.
 */
export async function publishOnce(
  stores: { local: ObjectStore; remote: ObjectStore },
  entry: { key: string; bytes: Uint8Array; limit: number },
  options: PublishFailures & { signal: AbortSignal },
): Promise<void> {
  const { key, bytes, limit } = entry;
  const { signal, mismatch } = options;
  const published = await stores.remote.read(key, limit, signal);
  if (published) {
    if (!Buffer.from(published).equals(Buffer.from(bytes))) {
      throw mismatch();
    }
    return;
  }
  if (await stores.local.read(key, limit, signal)) {
    throw options.pending();
  }
  await writeOnce(stores.local, { key, bytes }, { signal, mismatch });
  await writeOnce(stores.remote, { key, bytes }, { signal, mismatch });
}
