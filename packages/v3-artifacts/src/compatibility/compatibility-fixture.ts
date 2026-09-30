import type { ArtifactRef, Observation } from "@crawl-automation/v3-contracts";
import { artifactErrors } from "@crawl-automation/platform";
import type { LocalCopies } from "@crawl-automation/platform";
import { sha256 } from "@crawl-automation/platform";
import type { ObjectStore } from "@crawl-automation/platform";

/** Synthetic storage fixtures, never a provider or saved product page. */
export const evidenceOwner: Observation = {
  schemaVersion: 1,
  requestId: "req-1",
  observationId: "obs-1",
  brandId: "brand-1",
  sourceId: "source-1",
  listingId: "listing-1",
  variantId: null,
};

export const evidenceBytes = Buffer.from("retained evidence\r\n中文");
export const testSignal = () => new AbortController().signal;

export function evidenceRef(bytes: Uint8Array = evidenceBytes): ArtifactRef {
  return {
    schemaVersion: 1,
    artifactId: "artifact-1",
    observationId: "obs-1",
    sourceId: "source-1",
    listingId: "listing-1",
    variantId: null,
    kind: "text",
    mediaType: "text/plain",
    sha256: sha256(bytes),
    byteSize: bytes.length,
    objectKey: "results/evidence.txt",
    producer: { operationId: "operation-1", module: "text", implementationVersion: "text/1" },
  };
}

export function memoryObjects() {
  const objects = new Map<string, Uint8Array>();
  const calls: unknown[][] = [];
  const store: ObjectStore = {
    async read(key, limit) {
      calls.push(["read", key, limit]);
      const value = objects.get(key);
      if (value && value.length > limit) {
        throw artifactErrors.create("ARTIFACT.TOO_LARGE");
      }
      return value ? Buffer.from(value) : null;
    },
    async create(key, bytes, mediaType) {
      calls.push(["create", key, Buffer.from(bytes), mediaType]);
      if (objects.has(key)) {
        return "exists";
      }
      objects.set(key, Buffer.from(bytes));
      return "created";
    },
  };
  return { store, objects, calls };
}

export function memoryCopies(): LocalCopies {
  const copies = new Map<string, Uint8Array>();
  return {
    read: async (ref) => copies.get(ref.sha256) ?? null,
    retain: async (ref, bytes) => {
      copies.set(ref.sha256, Buffer.from(bytes));
    },
  };
}
