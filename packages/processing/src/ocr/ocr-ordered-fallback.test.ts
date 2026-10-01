import { expect, it, vi } from "vitest";
import { orderedFixture } from "../label/ordered-fixture.js";
import { signal } from "../testing/ocr-fixture.js";
import { verifiedFixture, jobStatus } from "./ocr-verified-fixture.js";

it.each([
  { timeout: true, unknown: false, code: "OCR.TIMEOUT" },
  { timeout: false, unknown: false, code: "OCR.JOB_FAILED" },
  { timeout: true, unknown: true, code: "OCR.TIMEOUT" },
])("the ordered reader respects the durable OCR Review: %j", async (options) => {
  const ocr = verifiedFixture(options);
  if (options.unknown) {
    ocr.query.mockImplementation(async () => Response.json(jobStatus("unknown")));
  }
  const outcome = await ocr.run();
  const receipt = await ocr.receipt.run({ input: ocr.input, outcome }, signal());
  if (receipt.status !== "review") {
    throw new Error("Expected OCR Review");
  }
  const fixture = await orderedFixture();
  const review = await ocr.reviews.read(receipt.reviewId);
  if (!review) {
    throw new Error("Missing durable OCR Review");
  }
  const input = { ...fixture.input, owner: review.observation };
  vi.mocked(fixture.inspection.review).mockResolvedValue(review);
  fixture.inspection.reviewSource = vi.fn(async () => receipt);
  const request = {
    input,
    states: [{ id: "source-0", status: "review" as const, reviewId: receipt.reviewId }],
  };
  expect(await fixture.selection.inspect(request, signal())).toMatchObject({
    complete: false,
    terminal: options.unknown,
    reason: {
      sourceId: "source-0",
      code: options.code,
      executionFact: options.unknown ? "unknown" : "executed",
    },
  });
  expect(fixture.plans.source).not.toHaveBeenCalled();
  expect(fixture.inspection.file).not.toHaveBeenCalled();
});
