import { expect, it } from "vitest";
import { signal } from "../testing/ocr-fixture.js";
import { jobStatus, verifiedFixture } from "./ocr-verified-fixture.js";

it.each(["failed", "cancelled", "done"])(
  "keeps %s after timeout as a known failed Review and never resends the image",
  async (state) => {
    const test = verifiedFixture({ timeout: true });
    test.query.mockImplementation(async () => Response.json(jobStatus(state)));
    const outcome = await test.run();
    expect(outcome).toMatchObject({ status: "review", code: "OCR.TIMEOUT", automaticRetry: false });
    const review = [...test.reviews.records.values()][0];
    expect(review).toMatchObject({
      failure: { code: "OCR.TIMEOUT", executionFact: "executed" },
      candidate: null,
      rawError: { details: { cleanup: { stopped: true } } },
    });
    expect(await test.receipt.run({ input: test.input, outcome }, signal())).toMatchObject({
      status: "review",
      code: "OCR.TIMEOUT",
      reviewId: review?.reviewId,
    });
    expect(test.ledger.prove).toHaveBeenCalledOnce();
    expect(test.cancel).not.toHaveBeenCalled();
    await test.run();
    expect(test.fetch.mock.calls.filter(([request]) => request.url.endsWith("/ocr"))).toHaveLength(
      1,
    );
    expect(test.query).toHaveBeenCalledOnce();
    expect(test.reviews.records.get(review?.reviewId ?? "")).toEqual(review);
  },
);

it("records proved transport loss with a non-UNKNOWN code while preserving its cause", async () => {
  const test = verifiedFixture();
  expect(await test.run()).toMatchObject({ status: "review", code: "OCR.JOB_FAILED" });
  expect([...test.reviews.records.values()][0]).toMatchObject({
    failure: { code: "OCR.JOB_FAILED", executionFact: "executed" },
    rawError: { details: { cause: "OCR.RESPONSE_UNKNOWN", cleanup: { stopped: true } } },
  });
  const [request, query] = test.fetch.mock.calls.map(([request]) => request);
  const jobId = request?.headers.get("x-ocr-job-id");
  expect(jobId).toBeTruthy();
  expect(query?.url).toBe(`https://ocr.example.test/jobs/${jobId}`);
  expect(test.fetch).toHaveBeenCalledTimes(2);
});

it("queries running work, cancels once, and polls until a GET proves termination", async () => {
  const test = verifiedFixture();
  test.query
    .mockResolvedValueOnce(Response.json(jobStatus("running")))
    .mockResolvedValueOnce(Response.json(jobStatus("running")))
    .mockResolvedValueOnce(Response.json(jobStatus("cancelled")));
  expect(await test.run()).toMatchObject({ code: "OCR.JOB_FAILED" });
  expect(test.fetch.mock.calls.map(([request]) => request.method)).toEqual([
    "POST",
    "GET",
    "POST",
    "GET",
    "GET",
  ]);
  expect(test.cancel).toHaveBeenCalledOnce();
  expect(test.ledger.prove).toHaveBeenCalledOnce();
});

it.each(["unknown", "running", "unreachable", "invalid", "http-error"])(
  "keeps %s unknown even after a terminal cancel acknowledgement",
  async (state) => {
    const test = verifiedFixture({ timeout: true });
    test.cancel.mockImplementation(async () => Response.json(jobStatus("cancelled")));
    test.query.mockImplementation(async () => {
      if (state === "unreachable") {
        throw new TypeError("job control unreachable");
      }
      const body = state === "invalid" ? { state: "failed" } : jobStatus(state);
      return Response.json(body, { status: state === "http-error" ? 503 : 200 });
    });
    expect(await test.run()).toMatchObject({ code: "OCR.TIMEOUT" });
    expect([...test.reviews.records.values()][0]?.failure.executionFact).toBe("unknown");
    expect(test.ledger.prove).not.toHaveBeenCalled();
    expect(test.fetch.mock.calls.filter(([request]) => request.url.endsWith("/ocr"))).toHaveLength(
      1,
    );
  },
);

it("does not claim known failure if durable stop proof cannot be saved", async () => {
  const test = verifiedFixture();
  test.ledger.prove.mockRejectedValue(new Error("ledger unavailable"));
  expect(await test.run()).toMatchObject({ code: "OCR.RESPONSE_UNKNOWN" });
  expect([...test.reviews.records.values()][0]).toMatchObject({
    failure: { executionFact: "unknown" },
    rawError: { details: { cleanup: { stopped: false, reason: "job_control_failed" } } },
  });
});

it.each([false, true])(
  "preserves pre-patch activity classification (timeout: %s)",
  async (timeout) => {
    const test = verifiedFixture({ legacy: true, timeout });
    const code = timeout ? "OCR.TIMEOUT" : "OCR.RESPONSE_UNKNOWN";
    expect(await test.run()).toMatchObject({ code });
    expect([...test.reviews.records.values()][0]).toMatchObject({
      failure: { code, executionFact: "unknown" },
      rawError: { details: { cleanup: { stopped: true } } },
    });
    expect(test.ledger.prove).toHaveBeenCalledOnce();
  },
);
