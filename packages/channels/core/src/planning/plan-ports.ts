import type { ArtifactRef, Observation, ReviewRecord } from "@crawl-automation/v3-contracts";

/** One object store (local disk or R2): bounded reads and write-once creates. */
export interface PlanObjectStore {
  read(key: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null>;
  create(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal): Promise<unknown>;
}

/** Keeps a local copy first, then publishes the same bytes to R2 once (the worker's RetainedPublication). */
export interface PlanPublication {
  readonly local: PlanObjectStore;
  readonly remote: PlanObjectStore;
  retain(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal): Promise<unknown>;
  publish(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal): Promise<unknown>;
}

/** Reads a retained artifact for its owner (local copy or R2), with the reference it was found under. */
export interface PlanSourceResolver {
  resolve(
    ref: ArtifactRef,
    owner: Observation,
    signal: AbortSignal,
  ): Promise<{ ref: ArtifactRef; bytes: Uint8Array }>;
}

/** The passive Review ledger: a planning failure is recorded once and read back, never retried. */
export interface PlanReviews {
  read(reviewId: string): Promise<ReviewRecord | null>;
  append(record: ReviewRecord): Promise<unknown>;
}

/** Checks retained bytes against their artifact reference (size, hash, media type). */
export interface PlanIntegrity {
  verifyBytes(ref: ArtifactRef, bytes: Uint8Array, limit: number): void;
}
