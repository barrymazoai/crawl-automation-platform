import { randomUUID } from "node:crypto";
import { ObjectKeySchema } from "@crawl-automation/v3-contracts";
import { sha256 } from "./integrity.js";
import { ArtifactError, type ObjectStore } from "./ports.js";

/** Durable immutable handoff. No provider or browser capability; an uncertain PUT is reconciled by GET only. */
export class RetainedPublication {
  constructor(readonly local: ObjectStore, readonly remote: ObjectStore) {}
  async retain(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal) {
    ObjectKeySchema.parse(key); signal.throwIfAborted();
    await this.local.create(key, bytes, mediaType, signal);
    const saved = await this.local.read(key, bytes.length, signal);
    if (!saved || sha256(saved) !== sha256(bytes)) throw new ArtifactError("ARTIFACT.CACHE_UNAVAILABLE");
  }
  async publish(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal) {
    await this.retain(key, bytes, mediaType, signal);
    const verify = (saved: Uint8Array | null) => {
      if (!saved) throw new ArtifactError("ARTIFACT.UPLOAD_UNKNOWN");
      if (sha256(saved) !== sha256(bytes)) throw new ArtifactError("ARTIFACT.KEY_CONFLICT");
    };
    const saved = await this.remote.read(key, bytes.length, signal);
    if (saved) { verify(saved); return; }
    const markerKey = `v3/publication-claims/${sha256(Buffer.from(key))}.json`;
    const marker = Buffer.from(JSON.stringify({ key, sha256: sha256(bytes), nonce: randomUUID() }));
    if (await this.local.create(markerKey, marker, "application/json", signal) !== "created") throw new ArtifactError("ARTIFACT.UPLOAD_UNKNOWN");
    const localClaim = await this.local.read(markerKey, 4096, signal);
    if (!localClaim || sha256(localClaim) !== sha256(marker)) throw new ArtifactError("ARTIFACT.CACHE_UNAVAILABLE");
    let claimed;
    try { claimed = await this.remote.create(markerKey, marker, "application/json", signal); }
    catch { throw new ArtifactError("ARTIFACT.UPLOAD_UNKNOWN"); }
    if (claimed !== "created") throw new ArtifactError("ARTIFACT.UPLOAD_UNKNOWN");
    const sharedClaim = await this.remote.read(markerKey, 4096, signal);
    if (!sharedClaim || sha256(sharedClaim) !== sha256(marker)) throw new ArtifactError("ARTIFACT.UPLOAD_UNKNOWN");
    try { await this.remote.create(key, bytes, mediaType, signal); } catch { /* One GET, no second PUT. */ }
    verify(await this.remote.read(key, bytes.length, signal));
  }
}
