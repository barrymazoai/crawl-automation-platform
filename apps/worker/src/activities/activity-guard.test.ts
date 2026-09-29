import { beforeEach, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
  info: { attempt: 1 },
  heartbeat: vi.fn(),
  cancellationSignal: new AbortController().signal,
}));
vi.mock("@temporalio/activity", () => ({ Context: { current: () => context } }));

import { AppError } from "@crawl-automation/platform";
import { guarded } from "./activity-guard.js";

const log = { error: vi.fn() } as never;

beforeEach(() => {
  context.info.attempt = 1;
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
