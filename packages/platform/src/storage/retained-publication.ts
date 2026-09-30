import { ObjectKeySchema } from "@crawl-automation/v3-contracts";
import { artifactErrors } from "./artifact-errors.js";
import { sha256 } from "./integrity.js";
import type { ObjectStore } from "./object-store.js";
import { claimPublication } from "./publication-claim.js";
import { logStorageRecovery } from "./storage-logger.js";

/** Immutable handoff. An uncertain PUT is reconciled by GET only. */
export class RetainedPublication {
  constructor(
    readonly local: ObjectStore,
    readonly remote: ObjectStore,
  ) {}

  // Preserve the ObjectStore-compatible public API used by old and new workers.
  // eslint-disable-next-line max-params
  async retain(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal) {
    ObjectKeySchema.parse(key);
    signal.throwIfAborted();
    await this.local.create(key, bytes, mediaType, signal);
    const saved = await this.local.read(key, bytes.length, signal);
    if (!saved || sha256(saved) !== sha256(bytes)) {
      throw artifactErrors.create("ARTIFACT.CACHE_UNAVAILABLE");
    }
  }

  // eslint-disable-next-line max-params -- Same immutable handoff API as retain and ObjectStore.
  async publish(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal) {
    await this.retain(key, bytes, mediaType, signal);
    const saved = await this.remote.read(key, bytes.length, signal);
    if (saved) {
      verifyPublication(saved, bytes);
      return;
    }
    await claimPublication(this, { key, bytes }, signal);
    try {
      await this.remote.create(key, bytes, mediaType, signal);
    } catch (error) {
      logStorageRecovery("Uncertain publication; verifying once by GET", error);
    }
    verifyPublication(await this.remote.read(key, bytes.length, signal), bytes);
  }
}

function verifyPublication(saved: Uint8Array | null, bytes: Uint8Array): void {
  if (!saved) {
    throw artifactErrors.create("ARTIFACT.UPLOAD_UNKNOWN");
  }
  if (sha256(saved) !== sha256(bytes)) {
    throw artifactErrors.create("ARTIFACT.KEY_CONFLICT");
  }
}
