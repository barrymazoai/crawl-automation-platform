import { describe, expect, it, vi } from "vitest";
import { RemoteReviews } from "@crawl-automation/v3-review";
import type { OcrActivityOutcome } from "@crawl-automation/v3-contracts";
import { defined } from "../testing/defined.js";
import { MemoryStore } from "../testing/memory-store.js";
import { STORAGE_ID, ocrStepSetup, signal } from "../testing/ocr-fixture.js";
import { ocrFailure } from "./ocr-errors.js";
import { OcrReceipt } from "./ocr-receipt.js";
import { OcrResults } from "./ocr-results.js";
import { OcrStep } from "./ocr-step.js";

function receiptSetup() {
  const fixture = ocrStepSetup();
  const receiptLocal = new MemoryStore();
  const receipt = new OcrReceipt({
    results: fixture.results,
    reviews: fixture.reviews,
    local: receiptLocal,
  });
  return { ...fixture, receiptLocal, receipt };
}

type Setup = ReturnType<typeof receiptSetup>;

/** The same task run by a cloud worker: no ledger, its own local store, the shared R2. */
function cloudStep(
  fixture: Setup,
  overrides: Partial<ConstructorParameters<typeof OcrStep>[0]> = {},
) {
  const results = new OcrResults({
    local: new MemoryStore(),
    remote: fixture.remote,
    registry: null,
    storageId: STORAGE_ID,
  });
  return new OcrStep({ ...fixture.deps, results, mode: "upload-only", ...overrides });
}

function failingApi(fixture: Setup) {
  fixture.api.recognize = vi.fn(async () => Promise.reject(new Error("offline")));
}

// Cases carried over from the former OCR receipt.
describe("OCR receipt", () => {
  it("settles a lost step answer from the registered result, writing nothing", async () => {
    const fixture = receiptSetup();
    await fixture.step.run(fixture.input, signal());
    const writes = fixture.remote.writes;
    const outcome = await fixture.receipt.run({ input: fixture.input, outcome: null }, signal());
    expect(outcome.status).toBe("registered");
    expect([fixture.api.calls, fixture.remote.writes, fixture.reviews.records.size]).toEqual([
      1,
      writes,
      0,
    ]);
  });

  it("checks a reported success against the registered result files", async () => {
    const fixture = receiptSetup();
    const outcome = await fixture.step.run(fixture.input, signal());
    expect(await fixture.receipt.run({ input: fixture.input, outcome }, signal())).toMatchObject({
      status: "registered",
    });
    const forged = {
      ...outcome,
      result: { ...(outcome as { result: object }).result, sha256: "f".repeat(64) },
    };
    expect(
      await fixture.receipt.run({ input: fixture.input, outcome: forged }, signal()),
    ).toMatchObject({
      code: "RECEIPT.IDENTITY_CONFLICT",
    });
  });

  it("an unconfirmed result stays a Review, kept locally, and never starts OCR", async () => {
    const fixture = receiptSetup();
    expect(
      await fixture.receipt.run({ input: fixture.input, outcome: null }, signal()),
    ).toMatchObject({
      status: "review",
      code: "RECEIPT.OCR_UNCONFIRMED",
      automaticRetry: false,
    });
    expect([fixture.api.calls, fixture.registry.writes, fixture.remote.writes]).toEqual([0, 0, 0]);
    const review = defined([...fixture.reviews.records.values()][0]);
    expect(fixture.receiptLocal.data.has(review.failure.evidenceKey)).toBe(true);
  });

  it("damaged evidence is never read as an empty OCR result", async () => {
    const fixture = receiptSetup();
    const outcome = await fixture.step.run(fixture.input, signal());
    fixture.remote.data.set(fixture.input.file.objectKey, Buffer.from("corrupt"));
    expect(await fixture.receipt.run({ input: fixture.input, outcome }, signal())).toMatchObject({
      code: "RECEIPT.EVIDENCE_UNVERIFIED",
    });
  });

  it("passes a confirmed step Review on unchanged, adding no Review and no call", async () => {
    const fixture = receiptSetup();
    failingApi(fixture);
    const outcome = await fixture.step.run(fixture.input, signal());
    const before = fixture.reviews.records.size;
    const { reviewId, code, operationId } = outcome as Extract<
      OcrActivityOutcome,
      { status: "review" }
    >;
    expect(await fixture.receipt.run({ input: fixture.input, outcome }, signal())).toMatchObject({
      reviewId,
      code,
      operationId,
    });
    expect(fixture.reviews.records.size).toBe(before);
    expect(fixture.api.recognize).toHaveBeenCalledOnce();
  });

  it("refuses a receipt for another operation and a Review ID it cannot find", async () => {
    const fixture = receiptSetup();
    failingApi(fixture);
    const outcome = (await fixture.step.run(fixture.input, signal())) as Extract<
      OcrActivityOutcome,
      { status: "review" }
    >;
    const foreign = { ...outcome, operationId: "foreign-operation" };
    expect(
      await fixture.receipt.run({ input: fixture.input, outcome: foreign }, signal()),
    ).toMatchObject({
      code: "RECEIPT.IDENTITY_CONFLICT",
    });
    const missing = { ...outcome, reviewId: "missing-review" };
    expect(
      await fixture.receipt.run({ input: fixture.input, outcome: missing }, signal()),
    ).toMatchObject({
      code: "RECEIPT.REVIEW_UNVERIFIED",
    });
  });

  it("a lost Review acknowledgement is read back by its ID, never appended twice", async () => {
    const fixture = receiptSetup();
    fixture.reviews.loseAcknowledgement = true;
    const append = vi.spyOn(fixture.reviews, "append");
    expect(
      await fixture.receipt.run({ input: fixture.input, outcome: null }, signal()),
    ).toMatchObject({
      status: "review",
    });
    expect(append).toHaveBeenCalledOnce();
  });

  it("an unreachable Review ledger is never reported as a recorded Review", async () => {
    const fixture = receiptSetup();
    fixture.reviews.unavailable = true;
    await expect(
      fixture.receipt.run({ input: fixture.input, outcome: null }, signal()),
    ).rejects.toThrow();
    expect(fixture.receiptLocal.data.size).toBe(1);
  });
});

describe("OCR receipt for a cloud worker", () => {
  it("registers what the cloud worker uploaded, from R2 alone, once", async () => {
    const fixture = receiptSetup();
    const outcome = await cloudStep(fixture).run(fixture.input, signal());
    expect(outcome.status).toBe("uploaded");
    const writes = fixture.remote.writes;
    const receipt = await fixture.receipt.run({ input: fixture.input, outcome }, signal());
    expect(receipt).toMatchObject({
      status: "registered",
      registration: { result: (outcome as { result: object }).result },
    });
    expect(await fixture.receipt.run({ input: fixture.input, outcome }, signal())).toEqual(receipt);
    expect([fixture.registry.writes, fixture.remote.writes, fixture.api.calls]).toEqual([
      1,
      writes,
      1,
    ]);
  });

  it("an uploaded report that does not match R2 is a Review, not a registration", async () => {
    const fixture = receiptSetup();
    const outcome = await cloudStep(fixture).run(fixture.input, signal());
    const forged = {
      ...outcome,
      result: { ...(outcome as { result: object }).result, sha256: "b".repeat(64) },
    };
    expect(
      await fixture.receipt.run({ input: fixture.input, outcome: forged }, signal()),
    ).toMatchObject({
      code: "RECEIPT.IDENTITY_CONFLICT",
    });
  });

  it("a Review the cloud worker kept in R2 enters the ledger only as this task's", async () => {
    const fixture = receiptSetup();
    const remoteReviews = new RemoteReviews(fixture.remote);
    const api = {
      ...fixture.api,
      recognize: async () => Promise.reject(ocrFailure("OCR.EMPTY", "executed")),
    };
    const outcome = await cloudStep(fixture, { api, reviews: remoteReviews }).run(
      fixture.input,
      signal(),
    );
    const { reviewId } = outcome as Extract<OcrActivityOutcome, { status: "review" }>;
    expect(fixture.reviews.records.has(reviewId)).toBe(false);
    const receipt = new OcrReceipt({ ...fixture, remoteReviews, local: new MemoryStore() });
    const confirmed = await receipt.run({ input: fixture.input, outcome }, signal());
    expect(confirmed).toMatchObject({ status: "review", reviewId, code: "OCR.EMPTY" });
    expect(fixture.reviews.records.has(reviewId)).toBe(true);
    const foreign = { ...outcome, code: "OCR.UNCLASSIFIED" };
    expect(await receipt.run({ input: fixture.input, outcome: foreign }, signal())).toMatchObject({
      code: "RECEIPT.IDENTITY_CONFLICT",
    });
  });
});
