import { expect, it, vi } from "vitest";
import { OcrInputSchema } from "@crawl-automation/v3-contracts";
import type { LabelModels } from "./label-models.js";
import { runOcrActivity } from "./ocr-activity.js";

function fixture() {
  const run = vi.fn(async (_raw: unknown, _signal: AbortSignal) => ({ status: "review" }));
  const ocrStep = vi.fn(() => ({ run }));
  const models = { ocrStep } as unknown as LabelModels;
  const owner = {
    schemaVersion: 1,
    requestId: "request",
    observationId: "observation",
    brandId: "brand",
    sourceId: "source",
    listingId: "listing",
    variantId: null,
  };
  const task = OcrInputSchema.parse({
    ...owner,
    operationId: "ocr",
    module: "ocr.file",
    implementationVersion: "multipart-ocr/2",
    policyVersion: "single-call/1",
    resultSchemaVersion: 2,
    configFingerprint: "a".repeat(64),
    inputFingerprint: "b".repeat(64),
    file: {
      schemaVersion: 1,
      observationId: owner.observationId,
      sourceId: owner.sourceId,
      listingId: owner.listingId,
      variantId: null,
      artifactId: "image",
      kind: "source-image",
      mediaType: "image/png",
      objectKey: "images/image.png",
      sha256: "c".repeat(64),
      byteSize: 8,
      producer: { operationId: "file", module: "file.acquire", implementationVersion: "file/1" },
    },
  });
  return { run, ocrStep, models, task };
}

it.each([false, true])(
  "dispatches a patched OCR activity without changing its task: %s",
  async (patched) => {
    const test = fixture();
    const signal = new AbortController().signal;
    const request = patched ? { input: test.task, verifiedFailure: true } : test.task;
    await runOcrActivity(test.models, request, signal);
    expect(test.ocrStep).toHaveBeenCalledExactlyOnceWith(patched);
    expect(test.run).toHaveBeenCalledExactlyOnceWith(test.task, signal);
  },
);

it("leaves malformed envelopes to normal task rejection without opting into fallback", async () => {
  const test = fixture();
  const request = { input: test.task, verifiedFailure: true, extra: true };
  await runOcrActivity(test.models, request, new AbortController().signal);
  expect(test.ocrStep).toHaveBeenCalledExactlyOnceWith(false);
  expect(test.run.mock.calls[0]?.[0]).toEqual(request);
});
