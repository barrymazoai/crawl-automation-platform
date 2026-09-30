import { artifactErrors, sha256 } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import type { OriginalCaptureRecord } from "./original-model.js";
import { OriginalEvidenceService } from "./original-service.js";

const html = "\ufeff<html><body>保留的 original\r\n</body></html>";
const bytes = Buffer.from(html);
const record: OriginalCaptureRecord = {
  operationId: "consumer",
  original: {
    channel: "swanson",
    capture: {
      operationId: "producer",
      sessionId: "session",
      sourceId: "source",
      listingId: "product",
      variantId: null,
      url: "https://example.com/product?original=true",
    },
    capturedAt: "2020-01-01T00:00:00.000Z",
    finalUrl: null,
    source: {
      schemaVersion: 1,
      artifactId: "html-producer",
      observationId: "html-producer",
      sourceId: "source",
      listingId: "product",
      variantId: null,
      kind: "source-html",
      mediaType: "text/html",
      objectKey: "v3/swanson-html/producer/original.html",
      sha256: sha256(bytes),
      byteSize: bytes.length,
      producer: {
        operationId: "producer",
        module: "swanson.http-original",
        implementationVersion: "swanson-html/1",
      },
    },
  },
};

function setup(saved: OriginalCaptureRecord | null = record) {
  const find = vi.fn(async () => saved);
  const read = vi.fn(async (): Promise<Uint8Array | null> => bytes);
  const service = new OriginalEvidenceService({ captures: { find }, objects: { read } });
  return { service, find, read };
}

describe("archived original evidence", () => {
  it.each([{ operationId: "consumer" }, { channel: "swanson" as const, listingId: "product" }])(
    "returns verified HTML and immutable provenance for %j",
    async (input) => {
      const test = setup();
      await expect(test.service.original(input)).resolves.toEqual({
        operationId: "consumer",
        channel: "swanson",
        listingId: "product",
        variantId: null,
        capturedAt: record.original.capturedAt,
        url: record.original.capture.url,
        sha256: sha256(bytes),
        byteSize: bytes.length,
        mediaType: "text/html",
        html,
      });
      expect(test.find).toHaveBeenCalledExactlyOnceWith(input);
      expect(test.read).toHaveBeenCalledExactlyOnceWith(
        record.original.source.objectKey,
        bytes.length,
        expect.any(AbortSignal),
      );
    },
  );

  it.each([Buffer.alloc(bytes.length, "x"), bytes.subarray(0, bytes.length - 1)])(
    "rejects changed hashes or byte sizes with the platform integrity error",
    async (damaged) => {
      const test = setup();
      test.read.mockResolvedValue(damaged);
      await expect(test.service.original({ operationId: "consumer" })).rejects.toMatchObject({
        code: "ARTIFACT.INTEGRITY",
      });
    },
  );

  it("does not read storage when there is no done capture", async () => {
    const test = setup(null);
    await expect(test.service.original({ operationId: "missing" })).rejects.toMatchObject({
      code: "EVIDENCE.NOT_FOUND",
    });
    expect(test.read).not.toHaveBeenCalled();
  });

  it("reports a missing R2 object as not found", async () => {
    const test = setup();
    test.read.mockResolvedValue(null);
    await expect(test.service.original({ operationId: "consumer" })).rejects.toMatchObject({
      code: "EVIDENCE.NOT_FOUND",
    });
  });

  it("propagates an unavailable read without retrying", async () => {
    const test = setup();
    const failure = artifactErrors.create("ARTIFACT.UNAVAILABLE");
    test.read.mockRejectedValue(failure);
    await expect(test.service.original({ operationId: "consumer" })).rejects.toBe(failure);
    expect(test.read).toHaveBeenCalledOnce();
  });

  it("requires storage configuration only for an existing original", async () => {
    const service = new OriginalEvidenceService({
      captures: { find: async () => record },
      objects: undefined,
    });
    await expect(service.original({ operationId: "consumer" })).rejects.toMatchObject({
      code: "EVIDENCE.READ_NOT_CONFIGURED",
    });
  });
});
