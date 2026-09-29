import type { ArtifactRef } from "@crawl-automation/v3-contracts";

export type ArtifactCode = "ARTIFACT.MISSING" | "ARTIFACT.INTEGRITY" | "ARTIFACT.MEDIA_TYPE" |
  "ARTIFACT.TOO_LARGE" | "ARTIFACT.UNAVAILABLE" | "ARTIFACT.UPLOAD_UNKNOWN" |
  "ARTIFACT.KEY_CONFLICT" | "ARTIFACT.CACHE_UNAVAILABLE" | "ARTIFACT.SCOPE";
export class ArtifactError extends Error {
  constructor(readonly code: ArtifactCode,readonly diagnostics?:{name?:string;code?:string;status?:number;requestId?:string}) { super(code); this.name = "ArtifactError"; }
}

// No delete, list, overwrite, URLs, or implicit retry in either port. The object store interface lives in the
// platform layer; it is re-exported here for the old packages.
export type { ObjectStore } from "@crawl-automation/platform";
export interface LocalCopies {
  read(ref: ArtifactRef, signal: AbortSignal): Promise<Uint8Array | null>;
  retain(ref: ArtifactRef, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}
export type ResolvedArtifact = { ref: ArtifactRef; bytes: Uint8Array; from: "local" | "remote"; cacheRetained: boolean };
