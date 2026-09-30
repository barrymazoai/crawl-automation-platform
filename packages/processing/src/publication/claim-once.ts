import { withCause } from "@crawl-automation/platform";
import { sha256 } from "@crawl-automation/platform";
import type { AppError, ObjectStore } from "@crawl-automation/platform";

const CLAIM_LIMIT = 65_536;

export interface ClaimOnceFailures {
  /** The create call itself failed; without this the store's own error is passed on. */
  createFailed?: (cause: unknown) => AppError;
  /** The key already existed: the work may already have run, or someone else holds the claim. */
  exists: () => AppError;
  /** The claim could not be read back exactly as written. */
  unverified: () => AppError;
}

/**
 * A create-once claim: writes these exact bytes under the key only if nothing is there, then reads them back. Only
 * the call that created it may go on; anyone else stops. Used for page intents, publication markers and the label
 * product handoff. (Model and OCR calls use `step/intent-claim.ts`, which compares the task, not the bytes.)
 */
export async function claimOnce(
  store: ObjectStore,
  claim: { key: string; bytes: Uint8Array },
  options: ClaimOnceFailures & { signal: AbortSignal },
): Promise<void> {
  let created;
  try {
    created = await store.create(claim.key, claim.bytes, "application/json", options.signal);
  } catch (error) {
    throw options.createFailed ? withCause(options.createFailed(error), error) : error;
  }
  if (created !== "created") {
    throw options.exists();
  }
  const saved = await store.read(claim.key, CLAIM_LIMIT, options.signal);
  if (!saved || sha256(saved) !== sha256(claim.bytes)) {
    throw options.unverified();
  }
}
