import { describe, expect, it } from "vitest";
import {
  ArtifactResolver as OldResolver,
  ArtifactError as OldError,
} from "@crawl-automation/v3-artifacts";
import { ArtifactResolver } from "./artifact-resolver.js";
import { artifactErrors } from "./artifact-errors.js";
import {
  evidenceBytes,
  evidenceOwner,
  evidenceRef,
  memoryCopies,
  memoryObjects,
  testSignal,
} from "./compatibility-fixture.js";
import type { LocalCopies } from "./artifact-types.js";
import type { ObjectStore } from "./object-store.js";

type Resolver = Pick<ArtifactResolver, "resolve" | "publish">;
const versions = [
  {
    name: "old",
    create: (local: LocalCopies, remote: ObjectStore) => new OldResolver(local, remote),
    unknown: () => new OldError("ARTIFACT.UPLOAD_UNKNOWN"),
  },
  {
    name: "platform",
    create: (local: LocalCopies, remote: ObjectStore) => new ArtifactResolver(local, remote),
    unknown: () => artifactErrors.create("ARTIFACT.UPLOAD_UNKNOWN"),
  },
];

async function publishAndResolve(resolver: Resolver) {
  const receipt = await resolver.publish(evidenceRef(), evidenceOwner, evidenceBytes, testSignal());
  const result = await resolver.resolve(evidenceRef(), evidenceOwner, testSignal());
  return { receipt, record: JSON.stringify(receipt), result };
}

describe("artifact resolver migration compatibility", () => {
  it("keeps refs, durable receipts, record JSON and stored bytes byte-identical", async () => {
    const results = [];
    for (const version of versions) {
      const remote = memoryObjects();
      const resolver = version.create(memoryCopies(), remote.store);
      results.push({
        ...(await publishAndResolve(resolver)),
        objects: [...remote.objects],
        calls: remote.calls,
      });
    }
    expect(results[1]).toEqual(results[0]);
  });

  it.each(versions)(
    "$name resolves remote once, then uses verified local bytes",
    async (version) => {
      const remote = memoryObjects();
      remote.objects.set(evidenceRef().objectKey, evidenceBytes);
      const resolver = version.create(memoryCopies(), remote.store);
      expect(await resolver.resolve(evidenceRef(), evidenceOwner, testSignal())).toMatchObject({
        bytes: evidenceBytes,
        from: "remote",
        cacheRetained: true,
      });
      expect(await resolver.resolve(evidenceRef(), evidenceOwner, testSignal())).toMatchObject({
        bytes: evidenceBytes,
        from: "local",
        cacheRetained: true,
      });
      expect(remote.calls).toHaveLength(1);
    },
  );

  it.each(versions)(
    "$name reconciles lost upload receipts with exactly one GET",
    async (version) => {
      const remote = memoryObjects();
      const create = remote.store.create;
      remote.store.create = async (...args) => {
        await create(...args);
        throw version.unknown();
      };
      const result = await publishAndResolve(version.create(memoryCopies(), remote.store));
      expect(result.receipt).toEqual({ ref: evidenceRef(), durable: true });
      expect(remote.calls.map((call) => call[0])).toEqual(["create", "read"]);
    },
  );

  it.each(versions)(
    "$name keeps corrupted caches and uses verified remote evidence",
    async (version) => {
      const remote = memoryObjects();
      remote.objects.set(evidenceRef().objectKey, evidenceBytes);
      const local: LocalCopies = {
        read: async () => Buffer.alloc(evidenceBytes.length),
        retain: async () => {
          throw new Error("cache conflict");
        },
      };
      expect(
        await version
          .create(local, remote.store)
          .resolve(evidenceRef(), evidenceOwner, testSignal()),
      ).toEqual({ ref: evidenceRef(), bytes: evidenceBytes, from: "remote", cacheRetained: false });
      expect(remote.calls.map((call) => call[0])).toEqual(["read"]);
    },
  );

  it.each(versions)("$name refuses wrong owners and cancellation before I/O", async (version) => {
    const remote = memoryObjects();
    const resolver = version.create(memoryCopies(), remote.store);
    const wrongOwner = { ...evidenceOwner, observationId: "other" };
    await expect(resolver.resolve(evidenceRef(), wrongOwner, testSignal())).rejects.toThrow();
    await expect(
      resolver.resolve(evidenceRef(), evidenceOwner, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(remote.calls).toEqual([]);
  });

  it.each(versions)("$name requires a local copy before remote publication", async (version) => {
    const remote = memoryObjects();
    const local: LocalCopies = {
      read: async () => null,
      retain: async () => {
        throw new Error("full disk");
      },
    };
    await expect(
      version
        .create(local, remote.store)
        .publish(evidenceRef(), evidenceOwner, evidenceBytes, testSignal()),
    ).rejects.toMatchObject({ code: "ARTIFACT.CACHE_UNAVAILABLE" });
    expect(remote.calls).toEqual([]);
  });

  it.each(versions)(
    "$name detects conflicting remote evidence without overwriting",
    async (version) => {
      const remote = memoryObjects();
      const conflict = Buffer.alloc(evidenceBytes.length);
      remote.objects.set(evidenceRef().objectKey, conflict);
      const local = memoryCopies();
      await expect(
        version
          .create(local, remote.store)
          .publish(evidenceRef(), evidenceOwner, evidenceBytes, testSignal()),
      ).rejects.toMatchObject({ code: "ARTIFACT.KEY_CONFLICT" });
      expect(remote.objects.get(evidenceRef().objectKey)).toEqual(conflict);
      expect(await local.read(evidenceRef(), testSignal())).toEqual(evidenceBytes);
    },
  );

  it.each(versions)(
    "$name rejects missing or corrupt remote bytes before caching",
    async (version) => {
      const remote = memoryObjects();
      const local = memoryCopies();
      const resolver = version.create(local, remote.store);
      await expect(
        resolver.resolve(evidenceRef(), evidenceOwner, testSignal()),
      ).rejects.toMatchObject({ code: "ARTIFACT.MISSING" });
      remote.objects.set(evidenceRef().objectKey, Buffer.alloc(evidenceBytes.length));
      await expect(
        resolver.resolve(evidenceRef(), evidenceOwner, testSignal()),
      ).rejects.toMatchObject({ code: "ARTIFACT.INTEGRITY" });
      expect(await local.read(evidenceRef(), testSignal())).toBeNull();
    },
  );
});
