import { describe, expect, it, vi } from "vitest";
import type { ObjectStore } from "@crawl-automation/platform";
import {
  acquisitionFingerprintMaterial,
  observationIdentity,
  type FileAcquireInput,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import { AcquireFileModule } from "./acquire-file-module.js";
import { fileErrors } from "./file-errors.js";
import { FileEvidence } from "./file-evidence.js";
import { FILE_CONFIG_FINGERPRINT, fileHash } from "./file-policy.js";
import type { Response, SourceLease } from "./file-ports.js";
import { recordFileReview, type FileEvidenceStores } from "./file-review.js";

const sourceUrl = "https://shop.test/image.jpg?signature=source-secret";
const finalUrl = "https://cdn.test/image.jpg?signature=final-secret";
const html = Buffer.from("<!DOCTYPE html><html><body>Private error body</body></html>");

function fileInput(): FileAcquireInput {
  const input: FileAcquireInput = {
    schemaVersion: 1,
    requestId: "req-1",
    observationId: "obs-1",
    operationId: "file-op-1",
    brandId: "brand-1",
    sourceId: "source-1",
    listingId: "listing-1",
    variantId: null,
    module: "file.acquire",
    implementationVersion: "1",
    policyVersion: "1",
    configFingerprint: FILE_CONFIG_FINGERPRINT,
    inputFingerprint: "0".repeat(64),
    resourceId: "image-1",
    binding: { sessionId: "session-1", egressId: "direct/1" },
    expectedSha256: null,
  };
  return { ...input, inputFingerprint: fileHash(acquisitionFingerprintMaterial(input)) };
}

function memoryStore() {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    read: vi.fn(async (key: string) => data.get(key) ?? null),
    create: vi.fn(async (key: string, bytes: Uint8Array) => {
      if (data.has(key)) {
        return "exists" as const;
      }
      data.set(key, Uint8Array.from(bytes));
      return "created" as const;
    }),
  } satisfies ObjectStore & { data: Map<string, Uint8Array> };
}

function response(status: number, headers: Response["headers"], bytes = Buffer.alloc(0)) {
  const readBody = vi.fn(async function* () {
    yield bytes;
  });
  return { status, headers, body: { [Symbol.asyncIterator]: readBody }, close: vi.fn(), readBody };
}

function setup(responses: Response[] = []) {
  const input = fileInput();
  const local = memoryStore();
  const records = new Map<string, ReviewRecord>();
  const stores: FileEvidenceStores = {
    local,
    remote: memoryStore(),
    copies: { read: vi.fn(), retain: vi.fn() },
    reviews: {
      read: async (id) => records.get(id) ?? null,
      append: async (record) => records.set(record.reviewId, record),
    },
  };
  const get = vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("Unexpected extra download");
    }
    return next;
  });
  const lease: SourceLease = {
    owner: observationIdentity(input),
    sourceId: input.sourceId,
    binding: input.binding,
    resourceId: input.resourceId,
    url: sourceUrl,
    allowedOrigins: ["https://shop.test", "https://cdn.test"],
    transport: { egressId: input.binding.egressId, targetResolution: "system", get },
    assertActive: vi.fn(),
    headersFor: () => ({ authorization: "request-secret" }),
    release: vi.fn(async () => undefined),
  };
  const module = new AcquireFileModule(new FileEvidence(stores), {
    access: { acquire: async () => lease },
    dns: { resolve: vi.fn() },
  });
  return { input, local, stores, records, get, lease, module };
}

async function runReview(fixture: ReturnType<typeof setup>, code: string) {
  const outcome = await fixture.module.run(fixture.input, new AbortController().signal);
  expect(outcome).toMatchObject({ status: "review", code, automaticRetry: false });
  expect(fixture.records.size).toBe(1);
  const review = [...fixture.records.values()][0];
  if (!review) {
    throw new Error("Missing persisted Review");
  }
  expect(review.failure).toMatchObject({ stage: "file.acquire", code, automaticRetry: false });
  const saved = fixture.local.data.get(review.failure.evidenceKey ?? "");
  expect(saved).toBeDefined();
  expect(JSON.parse(Buffer.from(saved ?? []).toString())).toEqual(review);
  expect(fixture.lease.release).toHaveBeenCalledTimes(1);
  const serialized = JSON.stringify(review);
  for (const privateValue of [
    "signature=",
    "secret",
    html.toString(),
    "set-cookie",
    "authorization",
  ]) {
    expect(serialized).not.toContain(privateValue);
  }
  return review;
}

describe("file failure Review diagnostics", () => {
  it.each([404, 403])(
    "retains HTTP %i and redirect context without reading the error body",
    async (status) => {
      const first = response(302, {
        location: "https://shop.test/moved.jpg?signature=redirect-secret",
      });
      const second = response(307, { location: finalUrl });
      const failed = response(
        status,
        {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(html.length),
          "set-cookie": "response-secret",
        },
        html,
      );
      const fixture = setup([first, second, failed]);
      const review = await runReview(fixture, "SOURCE.HTTP_STATUS");
      expect(review.rawError.details).toEqual({
        input: fixture.input,
        httpStatus: status,
        sourceUrl: "https://shop.test/image.jpg",
        finalUrl: "https://cdn.test/image.jpg",
        redirects: 2,
        contentType: "text/html; charset=utf-8",
        sniffedMediaType: null,
        byteSize: html.length,
      });
      expect(fixture.get).toHaveBeenCalledTimes(3);
      for (const answer of [first, second, failed]) {
        expect(answer.readBody).not.toHaveBeenCalled();
        expect(answer.close).toHaveBeenCalled();
      }
    },
  );

  it("retains declared JPEG versus sniffed HTML, response context and actual size", async () => {
    const redirect = response(301, { location: finalUrl });
    const failed = response(
      200,
      { "content-type": "image/jpeg", "set-cookie": "response-secret" },
      html,
    );
    const fixture = setup([redirect, failed]);
    const review = await runReview(fixture, "ARTIFACT.MEDIA_TYPE");
    expect(review.rawError.details).toEqual({
      input: fixture.input,
      httpStatus: 200,
      sourceUrl: "https://shop.test/image.jpg",
      finalUrl: "https://cdn.test/image.jpg",
      redirects: 1,
      contentType: "image/jpeg",
      sniffedMediaType: "text/html",
      byteSize: html.length,
    });
    expect(fixture.get).toHaveBeenCalledTimes(2);
    expect(redirect.readBody).not.toHaveBeenCalled();
    expect(failed.readBody).toHaveBeenCalledTimes(1);
    expect(redirect.close).toHaveBeenCalled();
    expect(failed.close).toHaveBeenCalled();
    expect(fixture.stores.copies.retain).not.toHaveBeenCalled();
  });

  it.each([undefined, "not-a-length", "9007199254740992"])(
    "keeps unknown size explicit for content-length %s",
    async (length) => {
      const failed = response(403, { "content-length": length });
      const fixture = setup([failed]);
      const review = await runReview(fixture, "SOURCE.HTTP_STATUS");
      expect(review.rawError.details).toMatchObject({
        httpStatus: 403,
        finalUrl: "https://shop.test/image.jpg",
        redirects: 0,
        contentType: null,
        sniffedMediaType: null,
        byteSize: null,
      });
      expect(fixture.get).toHaveBeenCalledTimes(1);
      expect(failed.readBody).not.toHaveBeenCalled();
    },
  );

  it("persists only bounded diagnostic fields, sanitizing URLs again at the Review boundary", async () => {
    const fixture = setup();
    const error = fileErrors.create("SOURCE.HTTP_STATUS", {
      cause: new Error("transport-secret"),
      details: {
        httpStatus: 404,
        sourceUrl: `${sourceUrl}#source-secret`,
        finalUrl: `${finalUrl}#final-secret`,
        redirects: 1,
        contentType: `image/jpeg; ${"x".repeat(300)}`,
        byteSize: 0,
        headers: { "set-cookie": "response-secret" },
        bytes: html,
      },
    });
    const outcome = await recordFileReview(fixture.stores, {
      input: fixture.input,
      stage: "file.acquire",
      error,
    });
    const review = fixture.records.get(outcome.reviewId);
    expect(review?.rawError.details).toEqual({
      input: fixture.input,
      httpStatus: 404,
      sourceUrl: "https://shop.test/image.jpg",
      finalUrl: "https://cdn.test/image.jpg",
      redirects: 1,
      contentType: error.details.contentType?.toString().slice(0, 256),
      sniffedMediaType: null,
      byteSize: 0,
    });
    expect(JSON.stringify(review)).not.toContain("secret");
  });
});
