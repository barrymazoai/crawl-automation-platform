import { afterEach, beforeEach, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
  info: {
    activityId: "activity-1",
    attempt: 1,
    workflowExecution: { workflowId: "product-1", runId: "temporal-run-1" } as
      { workflowId: string; runId: string } | undefined,
  },
  heartbeat: vi.fn(),
  cancellationSignal: new AbortController().signal,
}));
vi.mock("@temporalio/activity", () => ({ Context: { current: () => context } }));

import { AppError, createLogger } from "@crawl-automation/platform";
import { guarded } from "./activity-guard.js";

const lines: Record<string, unknown>[] = [];
const log = createLogger({
  name: "test",
  destination: { write: (line: string) => lines.push(JSON.parse(line)) },
});

beforeEach(() => {
  context.info.attempt = 1;
  context.info.workflowExecution = { workflowId: "product-1", runId: "temporal-run-1" };
  context.heartbeat.mockClear();
  context.cancellationSignal = new AbortController().signal;
  lines.length = 0;
});

afterEach(() => vi.useRealTimers());

it("runs the first attempt and returns its result", async () => {
  const run = guarded("captureProduct", async (raw) => ({ echoed: raw }), log);

  await expect(run("input")).resolves.toEqual({ echoed: "input" });
});

it("refuses provider work without its workflow owner", async () => {
  context.info.workflowExecution = undefined;
  const handler = vi.fn(async () => "ran");
  await expect(guarded("captureProduct", handler, log)("input")).rejects.toMatchObject({
    type: "RESOURCE.IDENTITY_CONFLICT",
    nonRetryable: true,
  });
  expect(handler).not.toHaveBeenCalled();
});

it("refuses a second attempt without running the handler", async () => {
  const handler = vi.fn(async () => "ran");
  context.info.attempt = 2;

  await expect(guarded("captureProduct", handler, log)("input")).rejects.toMatchObject({
    type: "PIPELINE.RETRY_DENIED",
    nonRetryable: true,
  });
  expect(handler).not.toHaveBeenCalled();
  expect(context.heartbeat).not.toHaveBeenCalled();
});

it("heartbeats immediately and every 2 seconds while work is pending, then clears the timer", async () => {
  vi.useFakeTimers();
  let finish: (value: string) => void = () => undefined;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const handler = vi.fn(async () => pending);
  const result = guarded("interpretText", handler, log)("task");
  expect(context.heartbeat).toHaveBeenCalledOnce();
  expect(handler).toHaveBeenCalledWith("task", context.cancellationSignal);
  await vi.advanceTimersByTimeAsync(28_000);
  expect(context.heartbeat).toHaveBeenCalledTimes(15);
  finish("done");
  await expect(result).resolves.toBe("done");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(context.heartbeat).toHaveBeenCalledTimes(15);
});

it.each(["failure", "cancelled"])("clears the heartbeat timer after %s", async (ending) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  context.cancellationSignal = controller.signal;
  const failure = new Error("work stopped");
  const handler = async () => {
    if (ending === "cancelled") {
      controller.abort(failure);
    }
    throw failure;
  };
  const result = guarded("ocrFile", handler, log)("task");
  await expect(result).rejects.toBeInstanceOf(Error);
  expect(vi.getTimerCount()).toBe(0);
  expect(context.heartbeat).toHaveBeenCalledOnce();
});

it("a failure leaves with the error's own code", async () => {
  const failing = async () => {
    throw new AppError("CAPTURE.NOT_FOUND", "SOURCE", { message: "gone" });
  };

  await expect(guarded("captureProduct", failing, log)("input")).rejects.toMatchObject({
    type: "CAPTURE.NOT_FOUND",
    nonRetryable: true,
  });
});

it("a failure without a code leaves as unresolved", async () => {
  const failing = async () => {
    throw new Error("socket closed");
  };

  await expect(guarded("captureProduct", failing, log)("input")).rejects.toMatchObject({
    type: "PIPELINE.ACTIVITY_UNRESOLVED",
  });
});

it("preserves unknown execution and cleanup facts for the workflow gate", async () => {
  const details = { executionFact: "unknown", cleanup: { stopped: false } };
  const failure = new AppError("OCR.RESPONSE_UNKNOWN", "PROCESSING", { message: "lost", details });
  await expect(
    guarded(
      "ocrFile",
      async () => {
        throw failure;
      },
      log,
    )({}),
  ).rejects.toMatchObject({
    type: "OCR.RESPONSE_UNKNOWN",
    details: [details],
    nonRetryable: true,
  });
});

it("carries the scan cool-down request in serializable Temporal failure details", async () => {
  const { wholeFoodsErrors } = await import("@crawl-automation/channels-wholefoods");
  const failure = wholeFoodsErrors.create("WHOLEFOODS.SEARCH_THROTTLED", {
    details: { cooldownRequested: true, archiveKeys: ["canary.html"] },
  });
  await expect(
    guarded(
      "scanBrandInBrowser",
      async () => {
        throw failure;
      },
      log,
    )({}),
  ).rejects.toMatchObject({
    type: "WHOLEFOODS.SEARCH_THROTTLED",
    nonRetryable: true,
    details: [{ cooldownRequested: true, archiveKeys: ["canary.html"] }],
  });
});

it("logs start and end with the run, product, workflow and Temporal run IDs", async () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const input = { pipeline: { runId, operationId: "product-op-1" } };
  await guarded("reviewProduct", async () => "done", log)(input);

  expect(lines.map((line) => line["msg"])).toEqual([
    "activity started",
    "activity finished",
    "usage measured",
  ]);
  expect(lines[1]).toMatchObject({
    activity: "reviewProduct",
    runId,
    operationId: "product-op-1",
    workflowId: "product-1",
    temporalRunId: "temporal-run-1",
  });
});
