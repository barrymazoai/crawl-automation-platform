import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireFile,
  FILE_CONFIG_FINGERPRINT,
  FILE_POLICY,
  publicAddress,
  permittedUrl,
  type SourceLease,
} from "@crawl-automation/channels-core";
import { acquireFile as oldAcquire, FILE_CONFIG_FINGERPRINT as oldFingerprint } from "../file.js";
import { fileInput, lease, png, response, signal } from "./file-fixture.js";
import { sign } from "../testing.fixture.js";

afterEach(() => vi.useRealTimers());
const implementations = [oldAcquire, acquireFile];
const dns = { resolve: async () => [{ address: "8.8.8.8", family: 4 as const }] };

async function scenario(acquire: typeof oldAcquire, name: string) {
  const calls: unknown[] = [];
  const close = vi.fn(),
    release = vi.fn(async () => undefined);
  let hits = 0;
  const source = lease(async (url, address, headers) => {
    calls.push([url.href, address, headers]);
    hits++;
    if (name === "network") throw Error("transport unavailable");
    const out = response();
    if (name === "redirect" && hits < 3)
      Object.assign(out, {
        status: 302,
        headers: { location: hits === 1 ? "/same-origin" : "https://cdn.example/image" },
      });
    if (name === "blocked")
      Object.assign(out, { status: 302, headers: { location: "https://evil.example/image" } });
    if (name === "loop") Object.assign(out, { status: 302, headers: { location: "/loop" } });
    if (name === "http") out.status = 429;
    if (name === "truncated") out.headers["content-length"] = String(png.length + 1);
    if (name === "encoding") out.headers["content-encoding"] = "gzip";
    if (name === "mime") out.headers["content-type"] = "image/jpeg";
    if (name === "pdf")
      return {
        ...response(Buffer.from("%PDF-1.4\n%%EOF\n"), { "content-type": "application/pdf" }),
        close,
      };
    return { ...out, close };
  });
  source.release = release;
  if (name === "session") source.binding.sessionId = "different";
  if (name === "headers") source.headersFor = () => ({ cookie: "injected\r\nheader" });
  if (name === "release")
    source.release = async () => {
      release();
      throw Error("release unavailable");
    };
  const input =
    name === "hash" ? sign({ ...fileInput(), expectedSha256: "0".repeat(64) }) : fileInput();
  let result: unknown;
  try {
    result = await acquire(input, { access: { acquire: async () => source }, dns }, signal());
  } catch (error) {
    result = (error as { code: string }).code;
  }
  return { result, calls, closes: close.mock.calls.length, releases: release.mock.calls.length };
}

describe("download compatibility without any network", () => {
  it("keeps the exact policy fingerprint", () =>
    expect(FILE_CONFIG_FINGERPRINT).toBe(oldFingerprint));
  it.each([
    "normal",
    "redirect",
    "blocked",
    "loop",
    "http",
    "truncated",
    "encoding",
    "mime",
    "pdf",
    "network",
    "session",
    "headers",
    "release",
    "hash",
  ])("%s: preserves output and cleanup", async (name) => {
    const [previous, current] = await Promise.all(
      implementations.map((acquire) => scenario(acquire, name)),
    );
    expect(current).toEqual(previous);
    expect(current?.releases).toBe(1);
  });

  it.each(implementations)("bounds hung DNS and releases the lease", async (acquire) => {
    vi.useFakeTimers();
    const release = vi.fn(async () => undefined);
    const pending = acquire(
      fileInput(),
      {
        access: { acquire: async () => ({ ...lease(), release }) },
        dns: { resolve: () => new Promise(() => undefined) },
      },
      new AbortController().signal,
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: "SOURCE.NETWORK_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(FILE_POLICY.timeoutMs + 1);
    await assertion;
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(implementations)(
    "abort closes a stalled body and releases only its lease",
    async (acquire) => {
      const controller = new AbortController(),
        close = vi.fn(),
        release = vi.fn(async () => undefined);
      const held: SourceLease = {
        ...lease(async () => ({
          ...response(),
          close,
          body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) },
        })),
        release,
      };
      const pending = acquire(
        fileInput(),
        { access: { acquire: async () => held }, dns },
        controller.signal,
      );
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "SOURCE.NETWORK_UNAVAILABLE" });
      expect(close).toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "198.18.0.1", "::1", "::ffff:8.8.8.8"])(
    "blocks %s",
    (address) => {
      expect(publicAddress(address)).toBe(false);
    },
  );
  it.each([
    "http://files.example/a",
    "https://127.1/a",
    "https://files.example:8443/a",
    "https://user:secret@files.example/a",
    "https://evil.example/a",
  ])("rejects %s", (url) => {
    expect(() => permittedUrl(url, ["https://files.example"])).toThrow("SOURCE.ORIGIN_BLOCKED");
  });
});
