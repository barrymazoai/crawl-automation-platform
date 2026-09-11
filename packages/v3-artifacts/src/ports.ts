import type { ArtifactRef } from "@crawl-automation/v3-contracts";

export type ArtifactCode = "ARTIFACT.MISSING" | "ARTIFACT.INTEGRITY" | "ARTIFACT.MEDIA_TYPE" |
  "ARTIFACT.TOO_LARGE" | "ARTIFACT.UNAVAILABLE" | "ARTIFACT.UPLOAD_UNKNOWN" |
  "ARTIFACT.KEY_CONFLICT" | "ARTIFACT.CACHE_UNAVAILABLE" | "ARTIFACT.SCOPE";
export class ArtifactError extends Error {
  constructor(readonly code: ArtifactCode) { super(code); this.name = "ArtifactError"; }
}

// No delete, list, overwrite, URLs, or implicit retry in either port.
export interface ObjectStore {
  read(key: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null>;
  create(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal): Promise<"created" | "exists">;
}
export interface LocalCopies {
  read(ref: ArtifactRef, signal: AbortSignal): Promise<Uint8Array | null>;
  retain(ref: ArtifactRef, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}
export type ResolvedArtifact = { ref: ArtifactRef; bytes: Uint8Array; from: "local" | "remote"; cacheRetained: boolean };
