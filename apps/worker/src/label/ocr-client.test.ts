import { expect, it, vi } from "vitest";
import { sha256 } from "@crawl-automation/platform";
import { OcrApiSettingsSchema } from "@crawl-automation/processing";
import type { ArtifactRef } from "@crawl-automation/v3-contracts";
import { ocrClient } from "./ocr-client.js";

const bytes = Buffer.from("89504e470d0a1a0a", "hex");
const file: ArtifactRef = {
  schemaVersion: 1,
  artifactId: "image",
  observationId: "observation",
  sourceId: "source",
  listingId: "listing",
  variantId: null,
  kind: "source-image",
  mediaType: "image/png",
  objectKey: "images/label.png",
  sha256: sha256(bytes),
  byteSize: bytes.length,
  producer: { operationId: "capture", module: "capture", implementationVersion: "capture/1" },
};

it.each([undefined, false, true])(
  "wires job control only when configured: %s",
  async (jobControl) => {
    const settings = OcrApiSettingsSchema.parse({
      baseUrl: "https://ocr.example.test/route",
      provider: "test/1",
      ...(jobControl === undefined ? {} : { jobControl }),
    });
    let jobId: string | null = null;
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url.startsWith(settings.baseUrl)).toBe(true);
      if (request.url.endsWith("/ocr")) {
        jobId = request.headers.get("x-ocr-job-id");
        throw new TypeError("connection closed");
      }
      expect(request.method).toBe("GET");
      expect(request.url).toBe(`${settings.baseUrl}/jobs/${jobId}`);
      return Response.json({
        state: "failed",
        worker_pid: 42,
        started_at: "2026-10-01T00:00:00Z",
        finished_at: "2026-10-01T00:01:30Z",
        cancel_requested: false,
      });
    });
    const client = ocrClient(settings, fetch);
    await expect(client.recognize(file, bytes, new AbortController().signal)).rejects.toMatchObject(
      {
        code: "OCR.RESPONSE_UNKNOWN",
        details: { cleanup: { stopped: jobControl === true } },
      },
    );
    expect(fetch).toHaveBeenCalledTimes(jobControl ? 2 : 1);
    expect(!!jobId).toBe(jobControl === true);
  },
);
