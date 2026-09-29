import { sha256 } from "@crawl-automation/v3-artifacts";
import type { AppError, ObjectStore } from "@crawl-automation/platform";

/**
 * Writes an object once, then reads it back. A lost acknowledgement is settled by the read-back, never by a second
 * write; different bytes already stored under the key fail with `mismatch`.
 */
export async function writeOnce(
  store: ObjectStore,
  entry: { key: string; bytes: Uint8Array },
  options: { signal: AbortSignal; mismatch: () => AppError },
): Promise<void> {
  const { key, bytes } = entry;
  const { signal } = options;
  try {
    await store.create(key, bytes, "application/json", signal);
  } catch {
    // The read-back below decides.
  }
  const saved = await store.read(key, bytes.length, signal);
  if (!saved || sha256(saved) !== sha256(bytes)) {
    throw options.mismatch();
  }
}
