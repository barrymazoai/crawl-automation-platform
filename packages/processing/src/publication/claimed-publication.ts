import { recordRecovery } from "@crawl-automation/platform";
import { randomUUID } from "node:crypto";
import { sha256 } from "@crawl-automation/platform";
import type { AppError, ObjectStore } from "@crawl-automation/platform";
import { hashString } from "../results/result-record.js";
import { claimOnce } from "./claim-once.js";

export interface ClaimedPublicationFailures {
  /** Different bytes are already stored under the key, or the read-back differs. */
  mismatch: () => AppError;
  /** Another publication holds the claim, or its state cannot be confirmed; it is never taken over. */
  pending: () => AppError;
  /** This worker's own claim marker could not be read back. */
  localUnverified: () => AppError;
}

export interface ClaimedEntry {
  key: string;
  bytes: Uint8Array;
  limit: number;
  /** Where the one-shot claim markers live, e.g. `page-publications`. */
  markerPrefix: string;
}

/**
 * Publishes a file to R2 once, behind a one-shot claim marker kept both locally and in R2. An identical R2 copy means
 * it is already published; a claim that exists anywhere means an earlier publication is unfinished, and it is not
 * retried — not even by a worker with an empty local store.
 */
export async function claimedPublish(
  stores: { local: ObjectStore; remote: ObjectStore },
  entry: ClaimedEntry,
  options: ClaimedPublicationFailures & { signal: AbortSignal },
): Promise<void> {
  const { local, remote } = stores;
  const { key, bytes, limit } = entry;
  const { signal } = options;
  const verify = (saved: Uint8Array | null) => {
    if (!saved || sha256(saved) !== sha256(bytes)) {
      throw options.mismatch();
    }
  };
  const prior = await remote.read(key, limit, signal);
  if (prior) {
    verify(prior);
    return;
  }
  const markerKey = `${entry.markerPrefix}/${hashString(key)}.json`;
  const marker = Buffer.from(JSON.stringify({ key, sha256: sha256(bytes), nonce: randomUUID() }));
  await claimLocally(local, { key: markerKey, bytes: marker }, options);
  await claimShared(remote, { key: markerKey, bytes: marker }, options);
  try {
    await remote.create(key, bytes, "application/json", signal);
  } catch (error) {
    recordRecovery(error, { operation: "publication/claimed-publication" });
    // The read-back below decides; never a second write.
  }
  verify(await remote.read(key, limit, signal));
}

function claimLocally(
  local: ObjectStore,
  marker: { key: string; bytes: Uint8Array },
  options: ClaimedPublicationFailures & { signal: AbortSignal },
): Promise<void> {
  const { signal, pending, localUnverified } = options;
  return claimOnce(local, marker, { signal, exists: pending, unverified: localUnverified });
}

function claimShared(
  remote: ObjectStore,
  marker: { key: string; bytes: Uint8Array },
  options: ClaimedPublicationFailures & { signal: AbortSignal },
): Promise<void> {
  // An unconfirmed shared claim may exist; it is never taken over.
  const { signal, pending } = options;
  return claimOnce(remote, marker, {
    signal,
    createFailed: pending,
    exists: pending,
    unverified: pending,
  });
}
