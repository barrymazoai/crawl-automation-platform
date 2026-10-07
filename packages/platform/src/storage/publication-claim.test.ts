import { describe, expect, it, vi } from "vitest";
import type { ObjectStore } from "./object-store.js";
import { R2Objects, type R2ClientPort } from "./r2-objects.js";
import { RetainedPublication } from "./retained-publication.js";
import { sha256 } from "./integrity.js";

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  async read(key: string) {
    return this.objects.get(key) ?? null;
  }
  async create(key: string, bytes: Uint8Array) {
    if (this.objects.has(key)) {
      return "exists" as const;
    }
    this.objects.set(key, bytes);
    return "created" as const;
  }
}

const signal = () => new AbortController().signal;
const bytes = Buffer.from('{"record":1}');
const key = "v3/product-enrichment/abc/record.json";

describe("publication after R2 errors (owner 2026-10-07)", () => {
  it("finishes the claim from this host's leftover marker when the shared claim never landed", async () => {
    const local = new MemoryStore();
    const remote = new MemoryStore();
    const flaky = { ...remote, read: remote.read.bind(remote), create: vi.fn() };
    flaky.create.mockRejectedValueOnce(new Error("R2 500"));
    flaky.create.mockImplementation(remote.create.bind(remote));
    const first = new RetainedPublication(local, flaky);
    await expect(first.publish(key, bytes, "application/json", signal())).rejects.toThrow(
      "ARTIFACT.UPLOAD_UNKNOWN",
    );
    await new RetainedPublication(local, flaky).publish(key, bytes, "application/json", signal());
    expect(remote.objects.get(key)).toEqual(bytes);
  });

  it("recognizes its own shared claim when only the object write failed", async () => {
    const local = new MemoryStore();
    const remote = new MemoryStore();
    const flaky = { read: remote.read.bind(remote), create: vi.fn(remote.create.bind(remote)) };
    flaky.create.mockImplementation(async (target: string, value: Uint8Array) => {
      if (target === key && flaky.create.mock.calls.length === 2) {
        throw new Error("R2 500");
      }
      return remote.create(target, value);
    });
    const publication = new RetainedPublication(local, flaky);
    await expect(publication.publish(key, bytes, "application/json", signal())).rejects.toThrow();
    await publication.publish(key, bytes, "application/json", signal());
    expect(remote.objects.get(key)).toEqual(bytes);
  });

  it("keeps a leftover marker for different bytes, or another claimant's shared marker, as a conflict", async () => {
    const local = new MemoryStore();
    const remote = new MemoryStore();
    const blocked = {
      read: remote.read.bind(remote),
      create: vi.fn(async () => "exists" as const),
    };
    await expect(
      new RetainedPublication(local, blocked).publish(key, bytes, "application/json", signal()),
    ).rejects.toThrow("ARTIFACT.UPLOAD_UNKNOWN");
    // This host's leftover marker claimed other bytes for the key: never reused.
    const stale = new MemoryStore();
    const marker = `v3/publication-claims/${sha256(Buffer.from(key))}.json`;
    stale.objects.set(
      marker,
      Buffer.from(JSON.stringify({ key, sha256: sha256(Buffer.from("other")), nonce: "x" })),
    );
    await expect(
      new RetainedPublication(stale, new MemoryStore()).publish(
        key,
        bytes,
        "application/json",
        signal(),
      ),
    ).rejects.toThrow("ARTIFACT.UPLOAD_UNKNOWN");
  });
});

describe("R2 conditional writes", () => {
  const scope = {
    endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
    bucket: "test-bucket",
    prefix: "tests/claims",
    timeoutMs: 5_000,
  };
  const serverError = (status: number) =>
    Object.assign(new Error("R2"), { $metadata: { httpStatusCode: status } });

  it("repeats a write that R2 answered with a server error", async () => {
    const send = vi.fn().mockRejectedValueOnce(serverError(500)).mockResolvedValueOnce({});
    const r2 = new R2Objects({ send } as unknown as R2ClientPort, scope);
    expect(await r2.create("v3/a/b.json", bytes, "application/json", signal())).toBe("created");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it(
    "does not repeat other errors, and gives up after three repeats",
    { timeout: 15_000 },
    async () => {
      const denied = vi.fn().mockRejectedValue(serverError(403));
      await expect(
        new R2Objects({ send: denied } as unknown as R2ClientPort, scope).create(
          "v3/a/b.json",
          bytes,
          "application/json",
          signal(),
        ),
      ).rejects.toThrow("ARTIFACT.UPLOAD_UNKNOWN");
      expect(denied).toHaveBeenCalledTimes(1);
      const down = vi.fn().mockRejectedValue(serverError(503));
      await expect(
        new R2Objects({ send: down } as unknown as R2ClientPort, scope).create(
          "v3/a/b.json",
          bytes,
          "application/json",
          signal(),
        ),
      ).rejects.toThrow("ARTIFACT.UPLOAD_UNKNOWN");
      expect(down).toHaveBeenCalledTimes(4);
    },
  );
});
