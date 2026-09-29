import { sha256 } from "@crawl-automation/v3-artifacts";
import type { AppError, ObjectStore } from "@crawl-automation/platform";

const INTENT_LIMIT = 65_536;

export interface ClaimOnceFailures {
  /** Writing or reading the intent could not be confirmed. */
  unknown: () => AppError;
  /** The intent already existed: the work may already have run. */
  executionUnknown: () => AppError;
}

/**
 * A create-once intent in R2 for work without a storage identity (page and PDF preparation). Only the call that
 * created it may do the work; anyone else learns that it may already have run and stops.
 */
export async function claimOnce(
  store: ObjectStore,
  intent: { key: string; bytes: Uint8Array },
  options: ClaimOnceFailures & { signal: AbortSignal },
): Promise<void> {
  let created;
  try {
    created = await store.create(intent.key, intent.bytes, "application/json", options.signal);
  } catch {
    throw options.unknown();
  }
  if (created !== "created") {
    throw options.executionUnknown();
  }
  const saved = await store.read(intent.key, INTENT_LIMIT, options.signal);
  if (!saved || sha256(saved) !== sha256(intent.bytes)) {
    throw options.unknown();
  }
}
