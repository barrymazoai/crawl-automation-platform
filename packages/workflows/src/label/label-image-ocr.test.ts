import { beforeEach, expect, it, vi } from "vitest";
import { CancelledFailure } from "@temporalio/common";

const env = vi.hoisted(() => ({ patched: true, call: vi.fn() }));
vi.mock("@temporalio/workflow", async () => ({
  ...(await import("@temporalio/common")),
  patched: (marker: string) => marker !== "ocr-verified-failure-v1" || env.patched,
  isCancellation: (error: unknown) => error instanceof CancelledFailure,
  log: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock("./label-stream.js", () => ({
  labelStream: () => ({ demand: true, ready: async () => true, finish: async () => true }),
}));
vi.mock("./label-run.js", async (original) => ({
  ...(await original<typeof import("./label-run.js")>()),
  labelRun: (entry: unknown, stream: unknown) => ({
    entry,
    stream,
    call: env.call,
    waiting: [],
    quarantined: [],
    heartbeatFailures: [],
  }),
}));
import { orderedLabel } from "./label-ordered.js";
import { LabelWorkflow } from "./label-workflow.js";
import { ocrWalkFixture, type OcrWalkMode } from "./ocr-walk-fixture.js";
import type { SourceWork } from "./label-source.js";

async function setup(mode: OcrWalkMode = "timeout") {
  const fixture = await ocrWalkFixture("ocr-walk", mode);
  const activities: Record<string, ReturnType<typeof vi.fn>> = Object.fromEntries(
    Object.entries(fixture.activities).map(([name, step]) => [name, vi.fn(step)]),
  );
  env.call.mockImplementation(async (_kind, name: string, value: unknown) => {
    const activity = activities[name];
    if (!activity) {
      throw new Error(`Unexpected activity ${name}`);
    }
    return activity(value);
  });
  const work: SourceWork = {
    issued: new Map(),
    ocrPending: new Map(),
    run: {
      entry: fixture.input,
      call: env.call,
      stream: { ready: async () => true, finish: async () => true },
      waiting: [],
      quarantined: [],
      heartbeatFailures: [],
    },
  };
  return { ...fixture, work, activities };
}

beforeEach(() => {
  env.patched = true;
  env.call.mockReset();
});

it.each(["timeout", "transport"] as const)(
  "continues after verified %s failure, retaining each OCR Review and processing each image once",
  async (mode) => {
    const test = await setup(mode);
    const walk = await orderedLabel(test.work, test.loaded);
    expect(walk.states).toEqual([
      { id: "image", status: "review", reviewId: "review-ocr-1" },
      { id: "image-next", status: "review", reviewId: "review-ocr-next" },
    ]);
    expect(walk.notStarted).toEqual([]);
    expect(test.activities["ocrFile"]?.mock.calls.map(([request]) => request)).toEqual(
      test.tasks.map((input) => ({ input, verifiedFailure: true })),
    );
    expect(test.activities["resolveOcrReceipt"]).toHaveBeenCalledTimes(2);
    expect(walk.reason).toMatchObject({
      code: mode === "timeout" ? "OCR.TIMEOUT" : "OCR.JOB_FAILED",
      executionFact: "executed",
    });
    expect(test.work.issued.size).toBe(0);
  },
);

it.each(["unknown", "unreachable"] as const)("keeps %s terminal", async (mode) => {
  const test = await setup(mode);
  const walk = await orderedLabel(test.work, test.loaded);
  expect(walk.states).toHaveLength(1);
  expect(walk.notStarted).toEqual([{ id: "image-next", status: "not_started" }]);
  expect(test.activities["ocrFile"]).toHaveBeenCalledOnce();
  expect(walk.reason).toMatchObject({ code: "OCR.TIMEOUT", executionFact: "unknown" });
});

it("keeps the pre-patch request and branch for old histories", async () => {
  env.patched = false;
  const test = await setup();
  const walk = await orderedLabel(test.work, test.loaded);
  expect(test.activities["ocrFile"]).toHaveBeenCalledExactlyOnceWith(test.tasks[0]);
  expect(walk.notStarted).toEqual([{ id: "image-next", status: "not_started" }]);
});

it("never advances after workflow cancellation", async () => {
  const test = await setup();
  const cancelled = new CancelledFailure("cancelled");
  test.activities["ocrFile"]?.mockRejectedValue(cancelled);
  await expect(orderedLabel(test.work, test.loaded)).rejects.toBe(cancelled);
  expect(test.activities["ocrFile"]).toHaveBeenCalledOnce();
  expect(test.activities["resolveOcrReceipt"]).not.toHaveBeenCalled();
});

it("retains the OCR cause when all images fail definitively", async () => {
  const test = await setup();
  expect(await LabelWorkflow(test.input)).toMatchObject({
    status: "review",
    automaticRetry: false,
  });
  expect(test.activities["ocrFile"]).toHaveBeenCalledTimes(2);
  expect(test.activities["reviewLabelProduct"]).toHaveBeenCalledWith(
    expect.objectContaining({
      states: [
        { id: "image", status: "review", reviewId: "review-ocr-1" },
        { id: "image-next", status: "review", reviewId: "review-ocr-next" },
      ],
      primaryFailure: { sourceId: "image", code: "OCR.TIMEOUT", executionFact: "executed" },
    }),
  );
});
