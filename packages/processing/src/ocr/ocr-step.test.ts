import { describe, expect, it, vi } from "vitest";
import { RemoteReviews } from "../step/remote-reviews.js";
import { defined } from "../testing/defined.js";
import { MemoryStore } from "../testing/memory-store.js";
import { STORAGE_ID, ocrStepSetup, resigned, signal } from "../testing/ocr-fixture.js";
import { ocrFailure } from "./ocr-errors.js";
import { ocrKeys } from "./ocr-kind.js";
import { OcrStep } from "./ocr-step.js";
import { OcrResults } from "./ocr-results.js";

const onlyReview = (reviews: { records: Map<string, { failure: object; candidate: unknown }> }) =>
  [...reviews.records.values()][0];

// Cases carried over from the former OCR module.
describe("OCR step", () => {
  it("keeps the raw answer, stores it durably, registers it, and reports only references", async () => {
    const fixture = ocrStepSetup();
    const outcome = await fixture.step.run(fixture.input, signal());
    expect(outcome.status).toBe("registered");
    expect(fixture.api.calls).toBe(1);
    const record = await fixture.registry.read(fixture.input.operationId);
    const stored = JSON.parse(
      Buffer.from(defined(fixture.remote.data.get(defined(record).result.objectKey))).toString(),
    );
    expect(stored.text).toBe("  Supplement Facts\nIngredients: test only.  ");
    expect(JSON.stringify(outcome)).not.toContain("Supplement Facts");
  });

  it("a repeated delivery of a finished task never calls the OCR API again", async () => {
    const fixture = ocrStepSetup();
    const first = await fixture.step.run(fixture.input, signal());
    expect(await fixture.step.run(fixture.input, signal())).toEqual(first);
    expect(fixture.api.calls).toBe(1);
  });

  it("eight concurrent deliveries on two nodes call the OCR API at most once", async () => {
    const fixture = ocrStepSetup();
    const other = new OcrStep({ ...fixture.deps, nodeId: "node-b" });
    const runs = Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? other : fixture.step).run(fixture.input, signal()),
    );
    const outcomes = await Promise.all(runs);
    expect(fixture.api.calls).toBe(1);
    expect(outcomes.some((outcome) => outcome.status === "registered")).toBe(true);
  });

  it("a lost intent acknowledgement never grants the call, then or later", async () => {
    const fixture = ocrStepSetup();
    fixture.remote.loseAcknowledgements = true;
    expect(await fixture.step.run(fixture.input, signal())).toMatchObject({
      code: "OCR.INTENT_UNKNOWN",
    });
    fixture.remote.loseAcknowledgements = false;
    expect(await fixture.step.run(fixture.input, signal())).toMatchObject({
      code: "OCR.EXECUTION_UNKNOWN",
    });
    expect(fixture.api.calls).toBe(0);
  });

  it("a timeout stays unknown and is not retried", async () => {
    const fixture = ocrStepSetup();
    fixture.api.recognize = async () => {
      fixture.api.calls++;
      throw ocrFailure("OCR.TIMEOUT");
    };
    expect(await fixture.step.run(fixture.input, signal())).toMatchObject({
      status: "review",
      code: "OCR.TIMEOUT",
    });
    expect(onlyReview(fixture.reviews)?.failure).toMatchObject({ executionFact: "unknown" });
    await fixture.step.run(fixture.input, signal());
    expect(fixture.api.calls).toBe(1);
  });

  it("a lost registration acknowledgement is read back, without another call or write", async () => {
    const fixture = ocrStepSetup();
    fixture.registry.loseAcknowledgement = true;
    expect(await fixture.step.run(fixture.input, signal())).toMatchObject({ status: "registered" });
    expect([fixture.registry.writes, fixture.api.calls, fixture.reviews.records.size]).toEqual([
      1, 1, 0,
    ]);
  });

  it("a result kept locally but not uploaded is a Review, and redelivery never repairs it", async () => {
    const fixture = ocrStepSetup();
    const upload = fixture.results.uploadMissing.bind(fixture.results);
    fixture.results.uploadMissing = async () =>
      Promise.reject(ocrFailure("OCR.HANDOFF_INCOMPLETE", "executed"));
    expect(await fixture.step.run(fixture.input, signal())).toMatchObject({ status: "review" });
    fixture.results.uploadMissing = upload;
    const writes = fixture.remote.writes;
    expect(await fixture.step.run(fixture.input, signal())).toMatchObject({
      code: "OCR.HANDOFF_INCOMPLETE",
    });
    expect([fixture.api.calls, fixture.remote.writes]).toEqual([1, writes]);
  });

  it("an explicit repair later lets redelivery succeed without another call", async () => {
    const fixture = ocrStepSetup();
    const upload = fixture.results.uploadMissing.bind(fixture.results);
    fixture.results.uploadMissing = async () =>
      Promise.reject(ocrFailure("OCR.HANDOFF_INCOMPLETE", "executed"));
    await fixture.step.run(fixture.input, signal());
    fixture.results.uploadMissing = upload;
    await fixture.results.uploadMissing(fixture.input, signal());
    await fixture.results.register(fixture.input, signal());
    expect(await fixture.step.run(fixture.input, signal())).toMatchObject({ status: "registered" });
    expect(fixture.api.calls).toBe(1);
  });

  it("an answer received just before cancellation is kept before the Review", async () => {
    const fixture = ocrStepSetup();
    const controller = new AbortController();
    fixture.api.recognize = async () => (
      controller.abort(),
      { text: "received before cancellation", lines: [] }
    );
    expect(await fixture.step.run(fixture.input, controller.signal)).toMatchObject({
      code: "OCR.CANCELLED",
    });
    expect(await fixture.results.inspect(fixture.input, signal())).toMatchObject({
      computedLocal: true,
    });
  });

  it("a lost Review acknowledgement is read back, not appended twice", async () => {
    const fixture = ocrStepSetup();
    fixture.reviews.loseAcknowledgement = true;
    fixture.api.recognize = async () => Promise.reject(ocrFailure("OCR.TIMEOUT"));
    expect(await fixture.step.run(fixture.input, signal())).toMatchObject({ status: "review" });
    expect(fixture.reviews.records.size).toBe(1);
  });

  it("an unreachable Review ledger is never reported as a recorded Review", async () => {
    const fixture = ocrStepSetup();
    fixture.reviews.unavailable = true;
    fixture.api.recognize = async () => Promise.reject(ocrFailure("OCR.TIMEOUT"));
    await expect(fixture.step.run(fixture.input, signal())).rejects.toMatchObject({
      code: "OCR.REVIEW_UNKNOWN",
    });
    expect(fixture.remote.data.has(ocrKeys.intent(fixture.input))).toBe(true);
  });

  it("an invalid task touches neither the OCR API nor R2", async () => {
    const fixture = ocrStepSetup();
    const invalid = { ...fixture.input, files: [fixture.input.file] };
    await expect(fixture.step.run(invalid, signal())).rejects.toMatchObject({
      code: "OCR.INVALID_INPUT",
    });
    expect([fixture.api.calls, fixture.remote.writes]).toEqual([0, 0]);
  });

  it("an intent held by a different task for the same operation is a conflict", async () => {
    const fixture = ocrStepSetup();
    fixture.api.recognize = async () => Promise.reject(ocrFailure("OCR.TIMEOUT"));
    await fixture.step.run(fixture.input, signal());
    const changed = resigned(fixture.input, { requestId: "changed-request" });
    const calls = vi.fn();
    const step = new OcrStep({ ...fixture.deps, api: { ...fixture.api, recognize: calls } });
    expect(await step.run(changed, signal())).toMatchObject({ code: "OCR.INTENT_CONFLICT" });
    expect(calls).not.toHaveBeenCalled();
  });

  it("a missing image is a Review before any intent is claimed", async () => {
    const fixture = ocrStepSetup();
    fixture.remote.data.delete(fixture.input.file.objectKey);
    expect(await fixture.step.run(fixture.input, signal())).toMatchObject({ status: "review" });
    expect(onlyReview(fixture.reviews)?.failure).toMatchObject({ executionFact: "not_executed" });
    expect([fixture.api.calls, fixture.remote.writes]).toEqual([0, 0]);
  });

  it("an oversized answer is a Review without the answer as its candidate", async () => {
    const fixture = ocrStepSetup();
    fixture.api.recognize = async () => ({ text: "x".repeat(1_500_000), lines: [] });
    expect(await fixture.step.run(fixture.input, signal())).toMatchObject({
      code: "OCR.OUTPUT_LIMIT",
    });
    expect(onlyReview(fixture.reviews)?.candidate).toBeNull();
  });

  it("a rendered PDF page keeps its parent and page through registration", async () => {
    const fixture = ocrStepSetup();
    const file = {
      ...fixture.input.file,
      kind: "pdf-page" as const,
      parentArtifactId: "parent-pdf",
      pageIndex: 3,
    };
    const page = resigned(fixture.input, { file });
    expect(await fixture.step.run(page, signal())).toMatchObject({ status: "registered" });
    const record = await fixture.registry.read(page.operationId);
    expect(record?.input.file).toMatchObject({
      kind: "pdf-page",
      parentArtifactId: "parent-pdf",
      pageIndex: 3,
    });
  });
});

describe("OCR step in cloud mode (no ledger)", () => {
  it("uploads, reports uploaded, and repeats without calling the OCR API again", async () => {
    const fixture = ocrStepSetup("upload-only");
    const first = await fixture.step.run(fixture.input, signal());
    expect(first).toMatchObject({ status: "uploaded", resultRegistered: false });
    const writes = fixture.remote.writes;
    expect(await fixture.step.run(fixture.input, signal())).toEqual(first);
    expect([fixture.api.calls, fixture.remote.writes, fixture.registry.writes]).toEqual([
      1,
      writes,
      0,
    ]);
  });

  it("keeps its Reviews in R2 when it has no ledger", async () => {
    const fixture = ocrStepSetup("upload-only");
    const reviews = new RemoteReviews(fixture.remote);
    fixture.api.recognize = async () => Promise.reject(ocrFailure("OCR.EMPTY", "executed"));
    const results = new OcrResults({
      ...fixture,
      local: new MemoryStore(),
      registry: null,
      storageId: STORAGE_ID,
    });
    const outcome = await new OcrStep({ ...fixture.deps, reviews, results }).run(
      fixture.input,
      signal(),
    );
    expect(outcome).toMatchObject({ status: "review", code: "OCR.EMPTY" });
    const reviewId = (outcome as { reviewId: string }).reviewId;
    expect((await reviews.read(reviewId))?.failure).toMatchObject({ executionFact: "executed" });
  });
});
