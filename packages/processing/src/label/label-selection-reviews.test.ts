import { ReviewRecordSchema } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import { labelCandidate, visionFingerprint } from "../testing/label-sources.js";
import { selectionFixture } from "./selection-test-helpers.js";

async function reviewedImage() {
  const fake = await selectionFixture(0);
  fake.request.states[1] = { id: "image-0", status: "review", reviewId: "image-review" };
  const source = await fake.plan.labelPlans.source(
    { input: fake.request.input, sourceId: "image-0" },
    new AbortController().signal,
  );
  if (source.status !== "prepared" || source.source.kind !== "image") {
    throw new Error("fixture must resolve to a vision source");
  }
  const task = source.source.task;
  const owner = fake.request.input.owner;
  const evidenceKey = "vision/image-review.json";
  const review = ReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId: "image-review",
    occurredAt: "2026-09-30T10:00:00.000Z",
    observation: owner,
    failure: {
      schemaVersion: 1,
      requestId: owner.requestId,
      observationId: owner.observationId,
      operationId: task.input.operationId,
      inputFingerprint: visionFingerprint(task),
      stage: "codex.vision",
      category: "PROCESSING",
      code: "VISION.LABEL_INCOMPLETE",
      executionFact: "executed",
      evidenceKey,
      blockedBy: null,
      automaticRetry: false,
    },
    rawError: {
      name: "VisionFailure",
      message: "incomplete label",
      stack: null,
      details: { task, evidenceKey },
    },
    candidate: {
      schema: "label-extraction/1",
      value: { ...labelCandidate(), formulaComplete: false },
    },
    inspection: { kind: "none" },
  });
  fake.inspector.review.mockResolvedValue(review);
  return { ...fake, review };
}

function decisions(fake: Awaited<ReturnType<typeof selectionFixture>>) {
  return fake.publish.mock.calls.find(([key]) => key.endsWith("/selection.json"))?.[1];
}

describe("LabelImageSelection.manifest reviewed earlier images", () => {
  it("retains an explicit skip reason when the earlier vision Review is no longer retained", async () => {
    const fake = await reviewedImage();
    fake.inspector.review.mockResolvedValue(null);
    const result = await fake.selection.manifest(fake.request, new AbortController().signal);
    expect(result.skipped).toContain("image-0");
    expect(decisions(fake)).toMatchObject({
      decisions: expect.arrayContaining([
        expect.objectContaining({ id: "image-0", reason: "incomplete_label_review_unretained" }),
      ]),
    });
  });

  it("checks an executed incomplete verdict against the exact image task", async () => {
    const fake = await reviewedImage();
    expect(
      (await fake.selection.manifest(fake.request, new AbortController().signal)).skipped,
    ).toContain("image-0");
    expect(decisions(fake)).toMatchObject({
      decisions: expect.arrayContaining([
        expect.objectContaining({ id: "image-0", reason: "incomplete_label" }),
      ]),
    });
    expect(fake.inspector.review).toHaveBeenCalledWith("image-review");
  });

  it.each(["not_executed", "unknown"] as const)(
    "does not invent a label verdict from %s work",
    async (executionFact) => {
      const fake = await reviewedImage();
      fake.review.failure.executionFact = executionFact;
      fake.review.candidate = null;
      await fake.selection.manifest(fake.request, new AbortController().signal);
      expect(decisions(fake)).toMatchObject({
        decisions: expect.arrayContaining([
          expect.objectContaining({ id: "image-0", reason: "incomplete_label_no_verdict" }),
        ]),
      });
    },
  );

  it("distinguishes a failed model turn from a label verdict", async () => {
    const fake = await reviewedImage();
    fake.review.failure.code = "VISION.MODEL_UNAVAILABLE";
    fake.review.candidate = null;
    await fake.selection.manifest(fake.request, new AbortController().signal);
    expect(decisions(fake)).toMatchObject({
      decisions: expect.arrayContaining([
        expect.objectContaining({
          id: "image-0",
          reason: "incomplete_label_no_verdict",
          code: "VISION.MODEL_UNAVAILABLE",
        }),
      ]),
    });
  });

  it("refuses to discard an earlier complete label even when its state says Review", async () => {
    const fake = await reviewedImage();
    fake.review.candidate = ReviewRecordSchema.shape.candidate.parse({
      schema: "label-extraction/1",
      value: labelCandidate(),
    });
    await expect(
      fake.selection.manifest(fake.request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CHANNEL.LABEL_SELECTION_UNVERIFIED" });
    expect(fake.publishManifest).not.toHaveBeenCalled();
  });

  it.each(["reviewId", "operationId", "inputFingerprint", "stage", "owner", "details"])(
    "refuses a Review with a mismatched %s",
    async (field) => {
      const fake = await reviewedImage();
      if (field === "reviewId") {
        fake.review.reviewId = "other-review";
      }
      if (field === "operationId") {
        fake.review.failure.operationId = "other-operation";
      }
      if (field === "inputFingerprint") {
        fake.review.failure.inputFingerprint = "f".repeat(64);
      }
      if (field === "stage") {
        fake.review.failure.stage = "codex.text";
      }
      if (field === "owner") {
        fake.review.observation = { ...fake.request.input.owner, listingId: "other-listing" };
      }
      if (field === "details") {
        fake.review.rawError.details = {};
      }
      await expect(
        fake.selection.manifest(fake.request, new AbortController().signal),
      ).rejects.toMatchObject({ code: "CHANNEL.LABEL_SELECTION_UNVERIFIED" });
      expect(fake.publishManifest).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid retained Review instead of silently skipping it", async () => {
    const fake = await reviewedImage();
    fake.inspector.review.mockResolvedValue({ reviewId: "image-review" });
    await expect(
      fake.selection.manifest(fake.request, new AbortController().signal),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(fake.publishManifest).not.toHaveBeenCalled();
  });

  it("propagates Review storage failures without claiming a skip", async () => {
    const fake = await reviewedImage();
    const failure = new Error("review store unavailable");
    fake.inspector.review.mockRejectedValue(failure);
    await expect(fake.selection.manifest(fake.request, new AbortController().signal)).rejects.toBe(
      failure,
    );
    expect(fake.publishManifest).not.toHaveBeenCalled();
  });
});

describe("LabelImageSelection.manifest empty OCR evidence", () => {
  async function emptyOcr() {
    const fake = await reviewedImage();
    fake.review.failure.stage = "ocr.file";
    fake.review.failure.code = "OCR.EMPTY";
    fake.review.candidate = null;
    fake.plan.resolutions.set("image-0", { status: "review", code: "OCR.EMPTY" });
    return fake;
  }

  it("skips executed empty OCR only after checking its saved source, preserving the code", async () => {
    const fake = await emptyOcr();
    const signal = new AbortController().signal;
    expect((await fake.selection.manifest(fake.request, signal)).skipped).toContain("image-0");
    expect(fake.inspector.reviewSource).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "image-0" }),
      fake.request.states[1],
      signal,
    );
    expect(decisions(fake)).toMatchObject({
      decisions: expect.arrayContaining([
        expect.objectContaining({ id: "image-0", reason: "verified_empty_ocr", code: "OCR.EMPTY" }),
      ]),
    });
  });

  it.each([{ status: "not_matched" }, { status: "review", code: "OCR.OTHER" }] as const)(
    "refuses an empty-OCR claim when saved source resolves to %j",
    async (resolution) => {
      const fake = await emptyOcr();
      fake.inspector.reviewSource.mockResolvedValue(resolution);
      await expect(
        fake.selection.manifest(fake.request, new AbortController().signal),
      ).rejects.toMatchObject({ code: "CHANNEL.LABEL_SELECTION_UNVERIFIED" });
      expect(fake.publishManifest).not.toHaveBeenCalled();
    },
  );

  it("refuses an empty-OCR Review owned by another listing", async () => {
    const fake = await emptyOcr();
    fake.review.observation = { ...fake.request.input.owner, listingId: "other" };
    await expect(
      fake.selection.manifest(fake.request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "CHANNEL.LABEL_SELECTION_UNVERIFIED" });
    expect(fake.inspector.reviewSource).not.toHaveBeenCalled();
  });
});
