import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@crawl-automation/platform";
import { imageSource } from "../testing/label-sources.js";
import { simpleImage } from "../testing/simple-label.js";
import { buildStepReview } from "../step/step-review.js";
import { encodeJson } from "../results/result-record.js";
import {
  prepareVisionRecord,
  visionKeys,
  visionResponse,
  visionTaskFingerprint,
} from "../vision/vision-files.js";
import { RecheckImageSource } from "./image-source.js";
import { recheckFixture, signal } from "./recheck-fixture.js";

async function imageFixture() {
  const base = await recheckFixture();
  const candidate = simpleImage();
  const { source } = imageSource(candidate, 0);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8WQAAAAASUVORK5CYII=",
    "base64",
  );
  const image = source.task.input.selection.image;
  image.sha256 = sha256(png);
  image.byteSize = png.length;
  base.remote.data.set(image.objectKey, png);
  const response = encodeJson(visionResponse(source.task, JSON.stringify(candidate)));
  const saved = prepareVisionRecord(
    source.task,
    { bytes: response, status: "candidate" },
    "test/1",
  );
  base.remote.data.set(saved.record.result.objectKey, response);
  base.remote.data.set(saved.record.completion.objectKey, saved.completion);
  base.remote.data.set(
    visionKeys.intent(source.task),
    encodeJson({
      input: source.task.input,
      fingerprint: visionTaskFingerprint(source.task),
      nonce: randomUUID(),
    }),
  );
  const imageRecords = { read: vi.fn(async () => saved.record) };
  const deps = { ...base.deps, imageRecords };
  return { ...base, source, candidate, saved, deps, reader: new RecheckImageSource(deps) };
}

describe("saved image answer revalidation", () => {
  it("reads registered image and completion hashes, verifies OCR selection, and revalidates the answer without writes", async () => {
    const fixture = await imageFixture();
    const writes = fixture.remote.writes;
    const result = await fixture.reader.read(fixture.source, null, signal());
    expect(result.entry?.kind).toBe("image");
    expect(result.receipt.kind).toBe("registered-result");
    expect(fixture.deps.verifyOcr).toHaveBeenCalledOnce();
    expect(fixture.deps.imageRecords.read).toHaveBeenCalledOnce();
    expect(fixture.remote.writes).toBe(writes);
  });

  it("revalidates a Review answer against its original response and registered Review candidate", async () => {
    const fixture = await imageFixture();
    const { task } = fixture.source;
    const review = buildStepReview({
      reviewId: "image-review",
      task: {
        ...task.input.selection.observation,
        operationId: task.input.operationId,
        inputFingerprint: visionTaskFingerprint(task),
      },
      observation: task.input.selection.observation,
      stage: "codex.vision",
      category: "PROCESSING",
      code: "VISION.LABEL_AMBIGUOUS",
      fact: "executed",
      evidenceKey: visionKeys.response(task),
      blockedBy: null,
      error: { name: "old-rule", details: {} },
      inspection: { kind: "none" },
      candidate: { schema: "label-extraction/1", value: fixture.candidate },
    });
    const result = await fixture.reader.read(fixture.source, review, signal());
    expect(result.entry?.candidate).toEqual(fixture.candidate);
    expect(result.receipt.receiptId).toBe(review.reviewId);
    expect(fixture.deps.imageRecords.read).not.toHaveBeenCalled();
  });

  it.each(["image", "result", "completion"] as const)("refuses tampered %s bytes", async (file) => {
    const fixture = await imageFixture();
    const ref =
      file === "image" ? fixture.source.task.input.selection.image : fixture.saved.record[file];
    fixture.remote.data.set(ref.objectKey, Buffer.from("corrupt"));
    await expect(fixture.reader.read(fixture.source, null, signal())).rejects.toMatchObject({
      code: "ARTIFACT.INTEGRITY",
    });
  });

  it("refuses an unverified OCR registration and never bypasses it with a complete candidate", async () => {
    const fixture = await imageFixture();
    fixture.deps.verifyOcr.mockRejectedValue(new Error("missing OCR receipt"));
    await expect(fixture.reader.read(fixture.source, null, signal())).rejects.toThrow(
      "missing OCR receipt",
    );
    expect(fixture.deps.imageRecords.read).not.toHaveBeenCalled();
  });

  it("retains current wire-protocol failures even when the decoded label looks complete", async () => {
    const fixture = await imageFixture();
    const source = {
      ...fixture.source,
      task: {
        ...fixture.source.task,
        input: { ...fixture.source.task.input, extractionProtocol: "label-extraction/2" as const },
      },
    };
    const wire = {
      codec: "label-visual-wire/2",
      label: fixture.candidate,
      otherIngredientsBlock: { text: "Cellulose, Silica", evidence: "different transcription" },
    };
    const bytes = encodeJson(visionResponse(source.task, JSON.stringify(wire)));
    const saved = prepareVisionRecord(source.task, { bytes, status: "candidate" }, "test/1");
    fixture.deps.imageRecords.read.mockResolvedValue(saved.record);
    fixture.remote.data.set(saved.record.result.objectKey, bytes);
    fixture.remote.data.set(saved.record.completion.objectKey, saved.completion);
    fixture.remote.data.set(
      visionKeys.intent(source.task),
      encodeJson({
        input: source.task.input,
        fingerprint: visionTaskFingerprint(source.task),
        nonce: randomUUID(),
      }),
    );
    const result = await fixture.reader.read(source, null, signal());
    expect(result.entry).toBeUndefined();
    expect(result.failure?.code).toBe("VISION.LABEL_INGREDIENT_BOUNDARY");
  });
});
