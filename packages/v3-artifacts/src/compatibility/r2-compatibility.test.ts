import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  R2Objects as OldObjects,
  R2ScopeSchema as OldScopeSchema,
  createR2Objects as oldCreateR2Objects,
} from "../index.js";
import { R2Objects } from "@crawl-automation/platform";
import { createR2Objects } from "@crawl-automation/platform";
import { R2ScopeSchema, type R2Scope } from "@crawl-automation/platform";
import { testSignal } from "./compatibility-fixture.js";

const scope: R2Scope = {
  endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
  bucket: "isolated-test",
  prefix: "v3-tests/compatibility",
  timeoutMs: 100,
  retries: 5,
};
type Request = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
};
type Reply = { statusCode: number; headers: Record<string, string>; body: Readable };
const clients: S3Client[] = [];
const versions = [
  { name: "old", store: OldObjects },
  { name: "platform", store: R2Objects },
];
const reply = (body: string, statusCode = 200): Reply => ({
  statusCode,
  headers: {},
  body: Readable.from([Buffer.from(body)]),
});

function setup(version: (typeof versions)[number], handler: (request: Request) => Promise<Reply>) {
  const client = new S3Client({
    endpoint: scope.endpoint,
    region: "auto",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: "FAKE_TEST_KEY", secretAccessKey: "FAKE_TEST_SECRET" },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { handle: async (request: Request) => ({ response: await handler(request) }) },
  });
  clients.push(client);
  return new version.store(client, scope);
}

afterEach(() => clients.splice(0).forEach((client) => client.destroy()));

describe("R2 storage wire compatibility (real AWS serializer, fake transport)", () => {
  it("keeps bucket/prefix keys, conditional headers and stored payload bytes identical", async () => {
    const results = [];
    const bytes = Buffer.from('{"manifest":{"schemaVersion":1},"unicode":"中文"}\r\n');
    for (const version of versions) {
      const requests: unknown[] = [];
      const store = setup(version, async (request) => {
        requests.push({
          method: request.method,
          path: request.path,
          body: request.body,
          contentType: request.headers["content-type"],
          contentLength: request.headers["content-length"],
          conditional: request.headers["if-none-match"],
        });
        expect(request.headers.authorization).toContain("AWS4-HMAC-SHA256");
        return reply(bytes.toString());
      });
      const key = "v3/manifests/sample.json";
      expect(await store.create(key, bytes, "application/json", testSignal())).toBe("created");
      expect(await store.read(key, bytes.length, testSignal())).toEqual(bytes);
      results.push(requests);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[1]?.[0]).toMatchObject({
      method: "PUT",
      conditional: "*",
      body: bytes,
      path: "/isolated-test/v3-tests/compatibility/v3/manifests/sample.json",
    });
  });

  it.each(versions)("$name treats 412 as exists and never overwrites", async (version) => {
    let calls = 0;
    const store = setup(version, async () => {
      calls++;
      return reply("<Error><Code>PreconditionFailed</Code></Error>", 412);
    });
    expect(await store.create("v3/a", Buffer.from("x"), "text/plain", testSignal())).toBe("exists");
    expect(calls).toBe(1);
  });

  it.each(versions)("$name only treats NoSuchKey as missing", async (version) => {
    const missing = setup(version, async () => reply("<Error><Code>NoSuchKey</Code></Error>", 404));
    expect(await missing.read("v3/a", 10, testSignal())).toBeNull();
    const bucket = setup(version, async () =>
      reply("<Error><Code>NoSuchBucket</Code></Error>", 404),
    );
    await expect(bucket.read("v3/a", 10, testSignal())).rejects.toMatchObject({
      code: "ARTIFACT.UNAVAILABLE",
    });
  });

  it.each(versions)("$name never retries failures even with retries=5", async (version) => {
    for (const statusCode of [403, 429, 500, 503]) {
      let calls = 0;
      const store = setup(version, async () => {
        calls++;
        return reply("<Error><Code>ExpiredToken</Code></Error>", statusCode);
      });
      await expect(store.read("v3/a", 10, testSignal())).rejects.toMatchObject({
        code: "ARTIFACT.UNAVAILABLE",
      });
      await expect(
        store.create("v3/a", Buffer.from("x"), "text/plain", testSignal()),
      ).rejects.toMatchObject({ code: "ARTIFACT.UPLOAD_UNKNOWN" });
      expect(calls).toBe(2);
    }
  });

  it.each(versions)(
    "$name bounds streamed bytes and destroys oversized bodies",
    async (version) => {
      for (const headers of [{}, { "content-length": "100" }]) {
        const body = Readable.from([Buffer.alloc(6), Buffer.alloc(6)]);
        const store = setup(version, async () => ({ statusCode: 200, headers, body }));
        await expect(store.read("v3/a", 10, testSignal())).rejects.toMatchObject({
          code: "ARTIFACT.TOO_LARGE",
        });
        expect(body.destroyed).toBe(true);
      }
    },
  );

  it.each(versions)("$name times out a stalled body without retrying", async (version) => {
    const body = new Readable({
      read() {
        /* Intentionally never emits data. */
      },
    });
    let calls = 0;
    const store = setup(version, async () => {
      calls++;
      return { statusCode: 200, headers: {}, body };
    });
    await expect(store.read("v3/a", 10, testSignal())).rejects.toMatchObject({
      code: "ARTIFACT.UNAVAILABLE",
    });
    expect(body.destroyed).toBe(true);
    expect(calls).toBe(1);
  });

  it.each(versions)(
    "$name refuses unsafe keys and aborted operations before transport",
    async (version) => {
      let calls = 0;
      const store = setup(version, async () => {
        calls++;
        return reply("");
      });
      for (const key of ["../outside", "/absolute", "https://signed.example/x?token=secret"]) {
        await expect(store.read(key, 10, testSignal())).rejects.toThrow();
        await expect(
          store.create(key, Buffer.from("x"), "text/plain", testSignal()),
        ).rejects.toThrow();
      }
      await expect(store.read("v3/a", 10, AbortSignal.abort())).rejects.toThrow();
      await expect(
        store.create("v3/a", Buffer.from("x"), "text/plain", AbortSignal.abort()),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    },
  );

  it("preserves safe diagnostics in platform error details without leaking SDK secrets", async () => {
    const results = [];
    for (const version of versions) {
      const store = setup(version, async () => {
        throw Object.assign(new Error("Authorization=private-secret"), {
          name: "TimeoutError",
          code: "ETIMEDOUT",
          headers: { authorization: "private-secret" },
          $metadata: { httpStatusCode: 503, requestId: "safe-request-id" },
        });
      });
      const error = (await store
        .create("v3/a", Buffer.from("x"), "text/plain", testSignal())
        .catch((caught: unknown) => caught)) as { diagnostics?: unknown; details?: unknown };
      expect(JSON.stringify(error)).not.toContain("private-secret");
      results.push(error.diagnostics ?? error.details);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[1]).toEqual({
      name: "TimeoutError",
      code: "ETIMEDOUT",
      status: 503,
      requestId: "safe-request-id",
    });
  });
});

describe("R2 settings compatibility", () => {
  it("keeps production SDK retries, addressing and checksum settings identical", async () => {
    const settings: S3Client["config"][] = [];
    const destroy = vi.spyOn(S3Client.prototype, "destroy").mockImplementation(function (
      this: S3Client,
    ) {
      settings.push(this.config);
    });
    try {
      for (const create of [oldCreateR2Objects, createR2Objects]) {
        create(scope, { accessKeyId: "test-only", secretAccessKey: "test-only" }).close();
      }
    } finally {
      destroy.mockRestore();
    }
    const values = await Promise.all(
      settings.map(async (config) => ({
        region: await config.region(),
        maxAttempts: await config.maxAttempts(),
        forcePathStyle: config.forcePathStyle,
        requestChecksum: await config.requestChecksumCalculation(),
        responseChecksum: await config.responseChecksumValidation(),
      })),
    );
    expect(values[1]).toEqual(values[0]);
    expect(values[1]).toEqual({
      region: "auto",
      maxAttempts: 1,
      forcePathStyle: true,
      requestChecksum: "WHEN_REQUIRED",
      responseChecksum: "WHEN_REQUIRED",
    });
  });

  it.each([
    {},
    { timeoutMs: undefined, retries: undefined },
    { retries: 0 },
    { retries: 6 },
    { prefix: "" },
    { prefix: "../outside" },
    { bucket: "other/bucket" },
    { unexpected: true },
    { endpoint: "http://localhost:9000" },
    { endpoint: `https://${"a".repeat(32)}.eu.r2.cloudflarestorage.com` },
    { endpoint: `https://${"a".repeat(32)}.fedramp.r2.cloudflarestorage.com` },
  ])("keeps parsed configuration and validation decisions for %j", (changes) => {
    const input = { ...scope, ...changes };
    const oldResult = OldScopeSchema.safeParse(input);
    const newResult = R2ScopeSchema.safeParse(input);
    expect(newResult.success).toBe(oldResult.success);
    if (newResult.success && oldResult.success) {
      expect(newResult.data).toEqual(oldResult.data);
    }
  });

  it.each([oldCreateR2Objects, createR2Objects])(
    "validates credentials and closes without I/O",
    (create) => {
      expect(() => create(scope, { accessKeyId: "", secretAccessKey: "" })).toThrow();
      const client = create(scope, { accessKeyId: "test-only", secretAccessKey: "test-only" });
      expect(client.store).toBeDefined();
      expect(client.close()).toBeUndefined();
    },
  );
});
