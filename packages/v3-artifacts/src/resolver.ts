import { ArtifactRefSchema, assertArtifactBelongsTo, type ArtifactRef, type Observation } from "@crawl-automation/v3-contracts";
import { verifyBytes } from "./integrity.js";
import { ArtifactError, type LocalCopies, type ObjectStore, type ResolvedArtifact } from "./ports.js";

export class ArtifactResolver {
  constructor(private readonly local: LocalCopies, private readonly remote: ObjectStore, private readonly maxBytes = 32 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ArtifactError("ARTIFACT.SCOPE");
  }
  private parse(raw: unknown, owner: Observation): ArtifactRef {
    const ref = assertArtifactBelongsTo(ArtifactRefSchema.parse(raw), owner);
    if (ref.byteSize > this.maxBytes) throw new ArtifactError("ARTIFACT.TOO_LARGE");
    return ref;
  }
  async resolve(raw: unknown, owner: Observation, signal: AbortSignal): Promise<ResolvedArtifact> {
    const ref = this.parse(raw, owner);
    signal.throwIfAborted();
    try {
      const bytes = await this.local.read(ref, signal);
      if (bytes) { verifyBytes(ref, bytes, this.maxBytes); return { ref, bytes, from: "local", cacheRetained: true }; }
    } catch { signal.throwIfAborted(); /* Inaccessible/corrupt local copy is not usable evidence. */ }
    const bytes = await this.remote.read(ref.objectKey, ref.byteSize, signal);
    if (!bytes) throw new ArtifactError("ARTIFACT.MISSING");
    verifyBytes(ref, bytes, this.maxBytes);
    let cacheRetained = false;
    try { await this.local.retain(ref, bytes, signal); cacheRetained = true; }
    catch { signal.throwIfAborted(); /* Remote bytes remain verified; never overwrite a bad local copy. */ }
    return { ref, bytes, from: "remote", cacheRetained };
  }
  async publish(raw: unknown, owner: Observation, rawBytes: Uint8Array, signal: AbortSignal): Promise<{ ref: ArtifactRef; durable: true }> {
    if (rawBytes.byteLength > this.maxBytes) throw new ArtifactError("ARTIFACT.TOO_LARGE");
    const ref = this.parse(raw, owner), bytes = Buffer.from(rawBytes);
    signal.throwIfAborted(); verifyBytes(ref, bytes, this.maxBytes);
    // Keep recoverable local evidence BEFORE any remote mutation.
    try { await this.local.retain(ref, bytes, signal); }
    catch { signal.throwIfAborted(); throw new ArtifactError("ARTIFACT.CACHE_UNAVAILABLE"); }
    try { await this.remote.create(ref.objectKey, bytes, ref.mediaType, signal); }
    catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ArtifactError) || error.code !== "ARTIFACT.UPLOAD_UNKNOWN") throw error;
      // One read-only reconciliation. Never reissue PUT or recompute provider work.
    }
    let actual;
    try { actual = await this.remote.read(ref.objectKey, ref.byteSize, signal); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof ArtifactError && error.code === "ARTIFACT.TOO_LARGE") throw new ArtifactError("ARTIFACT.KEY_CONFLICT");
      throw new ArtifactError("ARTIFACT.UPLOAD_UNKNOWN");
    }
    if (!actual) throw new ArtifactError("ARTIFACT.UPLOAD_UNKNOWN");
    try { verifyBytes(ref, actual, this.maxBytes); }
    catch { throw new ArtifactError("ARTIFACT.KEY_CONFLICT"); }
    return { ref, durable: true }; // Does not claim result registration or Temporal completion.
  }
}
