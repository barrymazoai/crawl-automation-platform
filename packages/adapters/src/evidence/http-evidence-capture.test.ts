import { appErrors } from "@crawl-automation/app";
import { describe, expect, it, vi } from "vitest";
import { evidenceFixture, captureRequest } from "./evidence-fixture.js";

const signal = () => new AbortController().signal;
const relative = (key: string) => key.slice("tests/v3/pages/".length);

describe("HTTP evidence archive", () => {
  it("archives original bytes and a manifest, then checks both before returning", async () => {
    const fixture = evidenceFixture();
    const fetch = vi.spyOn(fixture.pages, "fetchPage");
    const result = await fixture.capture.capture(captureRequest, signal());
    const key = relative(result.key);
    const manifestKey = key.replace(/\.html$/, ".json");
    const manifestBytes = fixture.objects.get(manifestKey);
    expect(manifestBytes).toBeDefined();
    const manifest = JSON.parse(Buffer.from(manifestBytes ?? []).toString());
    expect(result).toEqual({
      key: expect.stringMatching(/^tests\/v3\/pages\/gnc\/123456\/.+\.html$/),
      sha256: fixture.expectedHash,
      size: fixture.source.byteLength,
      capturedAt: expect.any(String),
      finalUrl: captureRequest.url,
      status: 200,
    });
    expect(fixture.objects.get(key)).toEqual(Uint8Array.from(fixture.source));
    expect(manifest).toMatchObject({
      codec: "test-page/1",
      ...result,
      target: { externalId: "123456", variantId: "789", url: captureRequest.url },
      request: captureRequest,
      fetchedVia: { mode: "http", provider: "fake" },
    });
    expect(fixture.events).toEqual([
      "channel:gnc:http",
      "address",
      expect.stringMatching(/^create:.+\.request.json$/),
      "fetch",
      `create:${key}`,
      `create:${manifestKey}`,
      `read:${key}`,
      `read:${manifestKey}`,
    ]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      {
        channel: "gnc",
        url: captureRequest.url,
        policy: { origins: ["https://page.test"], maxBytes: 1024, timeoutMs: 1000 },
      },
      expect.any(AbortSignal),
    );
  });

  it("refuses a foreign site before storage or fetching", async () => {
    const fixture = evidenceFixture();
    await expect(
      fixture.capture.capture({ ...captureRequest, url: "https://foreign.test/x" }, signal()),
    ).rejects.toThrow();
    expect(fixture.events).toEqual(["channel:gnc:http", "address"]);
  });

  it("keeps the intent and never retries a failed provider call", async () => {
    const fixture = evidenceFixture();
    const failure = new Error("provider unknown");
    const fetch = vi.spyOn(fixture.pages, "fetchPage").mockRejectedValue(failure);
    await expect(fixture.capture.capture(captureRequest, signal())).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([...fixture.objects.keys()]).toEqual([expect.stringMatching(/\.request\.json$/)]);
  });

  it("does not spend credits after an unknown intent publication", async () => {
    const fixture = evidenceFixture();
    const failure = new Error("upload unknown");
    vi.spyOn(fixture.store, "create").mockRejectedValue(failure);
    const fetch = vi.spyOn(fixture.pages, "fetchPage");
    await expect(fixture.capture.capture(captureRequest, signal())).rejects.toBe(failure);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["original", "manifest"] as const)(
    "does not fetch again after an unknown %s write",
    async (part) => {
      const fixture = evidenceFixture();
      const failure = new Error("upload unknown");
      const create = fixture.store.create.bind(fixture.store);
      const upload = vi.spyOn(fixture.store, "create").mockImplementation(async (...args) => {
        const [key] = args;
        const manifest = key.endsWith(".json") && !key.endsWith(".request.json");
        if (part === "original" ? key.endsWith(".html") : manifest) {
          throw failure;
        }
        return create(...args);
      });
      const fetch = vi.spyOn(fixture.pages, "fetchPage");
      await expect(fixture.capture.capture(captureRequest, signal())).rejects.toBe(failure);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(upload).toHaveBeenCalledTimes(part === "original" ? 2 : 3);
    },
  );

  it.each(["missing", "size", "hash", "manifest"])(
    "rejects %s read-back damage and retains originals",
    async (damage) => {
      const fixture = evidenceFixture();
      const read = fixture.store.read.bind(fixture.store);
      vi.spyOn(fixture.store, "read").mockImplementation(async (...args) => {
        const saved = await read(...args);
        if (damage === "manifest") {
          return args[0].endsWith(".json") ? null : saved;
        }
        if (damage === "missing") {
          return null;
        }
        return damage === "size" ? new Uint8Array(1) : new Uint8Array(saved?.length ?? 0);
      });
      await expect(fixture.capture.capture(captureRequest, signal())).rejects.toMatchObject({
        code: "EVIDENCE.ARCHIVE_UNVERIFIED",
      });
      expect(fixture.events.filter((event) => event === "fetch")).toHaveLength(1);
      expect(fixture.objects.size).toBe(3);
    },
  );

  it("does not overwrite or retry on a key conflict", async () => {
    const fixture = evidenceFixture();
    vi.spyOn(fixture.store, "create").mockResolvedValue("exists");
    await expect(fixture.capture.capture(captureRequest, signal())).rejects.toMatchObject({
      code: "EVIDENCE.ARCHIVE_CONFLICT",
    });
    expect(fixture.events).not.toContain("fetch");
  });

  it("separates simultaneous observations of one page", async () => {
    const fixture = evidenceFixture();
    const results = await Promise.all([
      fixture.capture.capture(captureRequest, signal()),
      fixture.capture.capture(captureRequest, signal()),
    ]);
    expect(new Set(results.map((result) => result.key)).size).toBe(2);
    expect(fixture.objects.size).toBe(6);
  });

  it("keeps storage error identity when read-back is unavailable", async () => {
    const fixture = evidenceFixture();
    const failure = appErrors.create("EVIDENCE.ARCHIVE_UNVERIFIED");
    vi.spyOn(fixture.store, "read").mockRejectedValue(failure);
    await expect(fixture.capture.capture(captureRequest, signal())).rejects.toBe(failure);
    expect(fixture.events.filter((event) => event === "fetch")).toHaveLength(1);
  });
});
