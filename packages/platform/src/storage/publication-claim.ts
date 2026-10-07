import { withCause } from "../errors/with-cause.js";
import { randomUUID } from "node:crypto";
import { artifactErrors } from "./artifact-errors.js";
import { sha256 } from "./integrity.js";
import type { ObjectStore } from "./object-store.js";

export async function claimPublication(
  stores: { local: ObjectStore; remote: ObjectStore },
  input: { key: string; bytes: Uint8Array },
  signal: AbortSignal,
): Promise<void> {
  const { local, remote } = stores;
  const { key, bytes } = input;
  const markerKey = `v3/publication-claims/${sha256(Buffer.from(key))}.json`;
  // Field order and JSON encoding are part of the persisted claim format.
  const fresh = Buffer.from(JSON.stringify({ key, sha256: sha256(bytes), nonce: randomUUID() }));
  const localCreated = await local.create(markerKey, fresh, "application/json", signal);
  const marker =
    localCreated === "created" ? fresh : await earlierClaim(local, { markerKey, ...input }, signal);
  const localClaim = await local.read(markerKey, 4096, signal);
  if (!localClaim || sha256(localClaim) !== sha256(marker)) {
    throw artifactErrors.create("ARTIFACT.CACHE_UNAVAILABLE");
  }
  try {
    await remote.create(markerKey, marker, "application/json", signal);
  } catch (error) {
    throw withCause(artifactErrors.create("ARTIFACT.UPLOAD_UNKNOWN"), error);
  }
  // The nonce makes the shared marker ours only when it holds exactly these bytes, whether this write created it or
  // an earlier, uncertain one did.
  const sharedClaim = await remote.read(markerKey, 4096, signal);
  if (!sharedClaim || sha256(sharedClaim) !== sha256(marker)) {
    throw artifactErrors.create("ARTIFACT.UPLOAD_UNKNOWN");
  }
}

/**
 * Owner 2026-10-07: an attempt cut off by an R2 error leaves this host's local marker behind. It is reused for the
 * same key and bytes, so the shared marker either still gets written or is recognized as ours; a marker for other
 * bytes stays a conflict.
 */
async function earlierClaim(
  local: ObjectStore,
  input: { markerKey: string; key: string; bytes: Uint8Array },
  signal: AbortSignal,
): Promise<Buffer> {
  const saved = await local.read(input.markerKey, 4096, signal);
  const claim = saved ? parseClaim(Buffer.from(saved)) : null;
  if (!saved || claim?.key !== input.key || claim.sha256 !== sha256(input.bytes)) {
    throw artifactErrors.create("ARTIFACT.UPLOAD_UNKNOWN");
  }
  return Buffer.from(saved);
}

function parseClaim(bytes: Buffer): { key?: unknown; sha256?: unknown } | null {
  try {
    return JSON.parse(bytes.toString()) as { key?: unknown; sha256?: unknown };
  } catch {
    return null;
  }
}
