import { withCause } from "../errors/with-cause.js";
import {
  ArtifactRefSchema,
  assertArtifactBelongsTo,
  type ArtifactRef,
  type Observation,
} from "@crawl-automation/v3-contracts";
import { artifactErrors } from "./artifact-errors.js";
import { publishArtifact } from "./artifact-publication.js";
import type { LocalCopies, ResolvedArtifact } from "./artifact-types.js";
import { verifyBytes } from "./integrity.js";
import type { ObjectStore } from "./object-store.js";
import { logStorageRecovery } from "./storage-logger.js";

export class ArtifactResolver {
  constructor(
    private readonly local: LocalCopies,
    private readonly remote: ObjectStore,
    private readonly maxBytes = 32 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw artifactErrors.create("ARTIFACT.SCOPE");
    }
  }

  private parse(raw: unknown, owner: Observation): ArtifactRef {
    const ref = assertArtifactBelongsTo(ArtifactRefSchema.parse(raw), owner);
    if (ref.byteSize > this.maxBytes) {
      throw artifactErrors.create("ARTIFACT.TOO_LARGE");
    }
    return ref;
  }

  async resolve(raw: unknown, owner: Observation, signal: AbortSignal): Promise<ResolvedArtifact> {
    const ref = this.parse(raw, owner);
    signal.throwIfAborted();
    try {
      const bytes = await this.local.read(ref, signal);
      if (bytes) {
        verifyBytes(ref, bytes, this.maxBytes);
        return { ref, bytes, from: "local", cacheRetained: true };
      }
    } catch (error) {
      signal.throwIfAborted();
      logStorageRecovery("Local evidence unusable; reading retained remote bytes", error, owner);
    }
    const bytes = await this.remote.read(ref.objectKey, ref.byteSize, signal);
    if (!bytes) {
      throw artifactErrors.create("ARTIFACT.MISSING");
    }
    verifyBytes(ref, bytes, this.maxBytes);
    let cacheRetained = false;
    try {
      await this.local.retain(ref, bytes, signal);
      cacheRetained = true;
    } catch (error) {
      signal.throwIfAborted();
      logStorageRecovery("Verified remote evidence could not be cached", error, owner);
    }
    return { ref, bytes, from: "remote", cacheRetained };
  }

  // Preserve the public storage calling convention while legacy workers coexist.
  // eslint-disable-next-line max-params
  async publish(
    raw: unknown,
    owner: Observation,
    rawBytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<{ ref: ArtifactRef; durable: true }> {
    if (rawBytes.byteLength > this.maxBytes) {
      throw artifactErrors.create("ARTIFACT.TOO_LARGE");
    }
    const ref = this.parse(raw, owner);
    const bytes = Buffer.from(rawBytes);
    signal.throwIfAborted();
    verifyBytes(ref, bytes, this.maxBytes);
    // Local recovery evidence must exist before any remote mutation.
    try {
      await this.local.retain(ref, bytes, signal);
    } catch (error) {
      signal.throwIfAborted();
      logStorageRecovery(
        "Publication stopped before remote write: cache unavailable",
        error,
        owner,
      );
      throw withCause(artifactErrors.create("ARTIFACT.CACHE_UNAVAILABLE"), error);
    }
    await publishArtifact(this.remote, { ref, bytes, maxBytes: this.maxBytes }, signal);
    return { ref, durable: true };
  }
}
