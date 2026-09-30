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
  const marker = Buffer.from(JSON.stringify({ key, sha256: sha256(bytes), nonce: randomUUID() }));
  const localCreated = await local.create(markerKey, marker, "application/json", signal);
  if (localCreated !== "created") {
    throw artifactErrors.create("ARTIFACT.UPLOAD_UNKNOWN");
  }
  const localClaim = await local.read(markerKey, 4096, signal);
  if (!localClaim || sha256(localClaim) !== sha256(marker)) {
    throw artifactErrors.create("ARTIFACT.CACHE_UNAVAILABLE");
  }
  let claimed;
  try {
    claimed = await remote.create(markerKey, marker, "application/json", signal);
  } catch {
    throw artifactErrors.create("ARTIFACT.UPLOAD_UNKNOWN");
  }
  if (claimed !== "created") {
    throw artifactErrors.create("ARTIFACT.UPLOAD_UNKNOWN");
  }
  const sharedClaim = await remote.read(markerKey, 4096, signal);
  if (!sharedClaim || sha256(sharedClaim) !== sha256(marker)) {
    throw artifactErrors.create("ARTIFACT.UPLOAD_UNKNOWN");
  }
}
