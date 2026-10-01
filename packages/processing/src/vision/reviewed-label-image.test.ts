import { expect, it } from "vitest";
import { visionSetup, signal } from "../testing/vision-fixture.js";
import { croppedPanel } from "../testing/split-label-fixture.js";
import { defined } from "../testing/defined.js";
import { visionKeys } from "./vision-files.js";

async function fixture() {
  const candidate = croppedPanel();
  const test = visionSetup({ answer: JSON.stringify(candidate) });
  const outcome = await test.step.run(test.task, signal());
  expect(outcome.status).toBe("review");
  if (outcome.status !== "review") {
    throw new Error("Expected review fixture");
  }
  const review = defined(await test.reviews.read(outcome.reviewId));
  return { ...test, candidate, review };
}

it("re-verifies reviewed partial bytes without a second model call or registering success", async () => {
  const test = await fixture();
  const before = new Map(test.remote.data);
  const result = await test.recovery.readReviewedLabel(
    { task: test.task, review: test.review },
    signal(),
  );
  expect(result.candidate).toEqual(test.candidate);
  expect(result.record).toMatchObject({ codec: "vision-reviewed/1", review: test.review });
  expect(result.record.result.objectKey).toBe(visionKeys.response(test.task));
  expect(test.model.calls).toBe(1);
  expect(test.remote.data).toEqual(before);
  expect(await test.registry.read(test.task.input.operationId)).toBeNull();
});

it.each(["image", "response", "intent", "ocr", "candidate", "fingerprint", "unknown"])(
  "refuses an unverified %s without retry",
  async (mode) => {
    const test = await fixture();
    if (mode === "image") {
      test.remote.data.delete(test.task.input.selection.image.objectKey);
    } else if (mode === "response") {
      test.remote.data.delete(visionKeys.response(test.task));
    } else if (mode === "intent") {
      test.remote.data.delete(visionKeys.intent(test.task));
    } else if (mode === "ocr") {
      test.ocr.verified = false;
    } else if (mode === "candidate") {
      test.review.candidate = null;
    } else if (mode === "fingerprint") {
      test.review.failure.inputFingerprint = "b".repeat(64);
    } else {
      test.review.failure.executionFact = "unknown";
    }
    await expect(
      test.recovery.readReviewedLabel({ task: test.task, review: test.review }, signal()),
    ).rejects.toThrow();
    expect(test.model.calls).toBe(1);
  },
);
