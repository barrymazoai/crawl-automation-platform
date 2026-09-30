import { vi } from "vitest";
import type { FileEvidenceStores } from "@crawl-automation/channels-core";
import type { ObjectStore } from "@crawl-automation/platform";
import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import { fileInput, lease, png, response } from "../testing.fixture.js";

export { fileInput, lease, png, response };
export const signal = () => AbortSignal.timeout(5000);

export function memoryObjects() {
  const objects = new Map<string, Uint8Array>();
  const calls: unknown[][] = [];
  const store: ObjectStore = {
    read: async (key, max) => {
      calls.push(["read", key, max]);
      return objects.get(key) ?? null;
    },
    create: async (key, bytes, mediaType) => {
      calls.push(["create", key, mediaType]);
      if (objects.has(key)) return "exists";
      objects.set(key, Buffer.from(bytes));
      return "created";
    },
  };
  return { store, objects, calls };
}

export function fileFixture() {
  const local = memoryObjects(),
    remote = memoryObjects();
  const retained = new Map<string, Uint8Array>();
  const reviews = new Map<string, ReviewRecord>();
  const get = vi.fn(async () => response());
  const release = vi.fn(async () => undefined);
  const source = {
    access: { acquire: async () => ({ ...lease(get), release }) },
    dns: { resolve: vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]) },
  };
  const deps: FileEvidenceStores = {
    local: local.store,
    remote: remote.store,
    copies: {
      read: async (ref) => retained.get(ref.objectKey) ?? null,
      retain: async (ref, bytes) => {
        retained.set(ref.objectKey, Buffer.from(bytes));
      },
    },
    reviews: {
      read: async (id) => reviews.get(id) ?? null,
      append: async (review) => {
        reviews.set(review.reviewId, review);
      },
    },
  };
  return { input: fileInput(), local, remote, retained, reviews, get, release, source, deps };
}

export type Fixture = ReturnType<typeof fileFixture>;
