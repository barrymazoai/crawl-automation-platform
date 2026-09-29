import { beforeEach, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
  info: { attempt: 1, workflowExecution: { workflowId: "product-1", runId: "temporal-run-1" } },
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
  lines.length = 0;
});

it("runs the first attempt and returns its result", async () => {
  const run = guarded("captureProduct", async (raw) => ({ echoed: raw }), log);

  await expect(run("input")).resolves.toEqual({ echoed: "input" });
});

it("refuses a second attempt without running the handler", async () => {
  const handler = vi.fn(async () => "ran");
  context.info.attempt = 2;

  await expect(guarded("captureProduct", handler, log)("input")).rejects.toMatchObject({
    type: "PIPELINE.RETRY_DENIED",
    nonRetryable: true,
  });
  expect(handler).not.toHaveBeenCalled();
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

it("logs start and end with the run, product, workflow and Temporal run IDs", async () => {
  const runId = "11111111-1111-4111-8111-111111111111";
  const input = { pipeline: { runId, operationId: "product-op-1" } };
  await guarded("reviewProduct", async () => "done", log)(input);

  expect(lines.map((line) => line["msg"])).toEqual(["activity started", "activity finished"]);
  expect(lines[1]).toMatchObject({
    activity: "reviewProduct",
    runId,
    operationId: "product-op-1",
    workflowId: "product-1",
    temporalRunId: "temporal-run-1",
  });
});
