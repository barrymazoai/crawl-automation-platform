import type { ArtifactRef } from "@crawl-automation/v3-contracts";

export interface LocalCopies {
  read(ref: ArtifactRef, signal: AbortSignal): Promise<Uint8Array | null>;
  retain(ref: ArtifactRef, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}

export type ResolvedArtifact = {
  ref: ArtifactRef;
  bytes: Uint8Array;
  from: "local" | "remote";
  cacheRetained: boolean;
};
