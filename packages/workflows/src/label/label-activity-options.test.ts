import { beforeEach, expect, it, vi } from "vitest";
import { ApplicationFailure, TimeoutFailure } from "@temporalio/common";

const env = vi.hoisted(() => ({ patch: vi.fn(), proxy: vi.fn() }));
vi.mock("@temporalio/workflow", async () => ({
  ...(await vi.importActual("@temporalio/workflow")),
  patched: env.patch,
  proxyActivities: env.proxy,
}));

import { activityCodes, activityErrors } from "@crawl-automation/platform/errors/activity";
import { imageActivityOptions } from "@crawl-automation/v3-contracts";
import { heartbeatTimeout, once, withDownloadHeartbeat } from "../activity-options.js";
import type { PipelineActivities } from "../pipeline-model.js";
import { isHeartbeatTimeout, withHeartbeatFailure } from "./activity-heartbeat.js";
import { labelActivityOptions } from "./label-activity-options.js";
import { entry } from "./label-fixture.js";
import { labelRun } from "./label-run.js";

beforeEach(() => {
  env.patch.mockReset().mockReturnValue(true);
  env.proxy.mockReset();
});

it.each(["activities", "ocr", "model"])("%s label calls heartbeat with one attempt", (queue) => {
  expect(labelActivityOptions(queue, true)).toEqual({
    ...imageActivityOptions(queue),
    heartbeatTimeout: "30 seconds",
    retry: { maximumAttempts: 1 },
  });
  expect(labelActivityOptions(queue, false)).toEqual(imageActivityOptions(queue));
});

it.each([true, false])("label dispatch uses the patch decision (%s)", async (patched) => {
  env.patch.mockReturnValue(patched);
  env.proxy.mockReturnValue({ loadLabelPlan: vi.fn(async () => "plan") });
  const stream = { ready: async () => true, finish: async () => true };
  await expect(labelRun(entry, stream).call("activities", "loadLabelPlan", {})).resolves.toBe(
    "plan",
  );
  expect(env.proxy).toHaveBeenCalledWith(labelActivityOptions(entry.queues.activities, patched));
});

it("checks label heartbeats after lazy legacy gate initialization", async () => {
  env.patch.mockImplementation((marker) => marker !== "resource-gate-v1");
  env.proxy.mockReturnValue({ loadLabelPlan: vi.fn(async () => "plan") });
  const run = labelRun(
    {
      ...entry,
      resources: {
        queue: "resources",
        maxWaitSeconds: 10,
        releaseOnReview: true,
        activities: {},
      },
    },
    { ready: async () => true, finish: async () => true },
  );
  expect(env.patch.mock.calls).toEqual([["resource-gate-v1"]]);
  await expect(run.call("activities", "loadLabelPlan", {})).resolves.toBe("plan");
  expect(env.patch.mock.calls).toEqual([
    ["resource-gate-v1"],
    ["resource-recovery-bounds-v1"],
    ["resource-wait-backoff-v1"],
    ["resource-review-release-v1"],
    ["label-heartbeat-v1"],
  ]);
});

it("changes only the download proxy and converts its timeout for the product Review", async () => {
  const timeout = new TimeoutFailure("expired", undefined, "HEARTBEAT");
  const acquireProductFile = vi.fn(async () => {
    throw timeout;
  });
  const pipeline = {
    acquireProductFile: vi.fn(),
    reviewProduct: vi.fn(),
  } as unknown as PipelineActivities;
  env.proxy.mockReturnValue({ acquireProductFile });
  const wrapped = withDownloadHeartbeat(pipeline, "files");
  expect(wrapped.reviewProduct).toBe(pipeline.reviewProduct);
  expect(env.patch).not.toHaveBeenCalled();
  expect(env.proxy).not.toHaveBeenCalled();
  await expect(wrapped.acquireProductFile({} as never)).rejects.toMatchObject({
    type: activityCodes.heartbeatTimeout,
    nonRetryable: true,
  });
  expect(env.patch).toHaveBeenCalledExactlyOnceWith("download-heartbeat-v1");
  expect(env.proxy).toHaveBeenCalledWith({ taskQueue: "files", ...once, heartbeatTimeout });
  expect(wrapped.reviewProduct).toBe(pipeline.reviewProduct);
  expect(pipeline.acquireProductFile).not.toHaveBeenCalled();
  expect(acquireProductFile).toHaveBeenCalledOnce();
});

it("keeps download options and failures unchanged without the patch", async () => {
  env.patch.mockReturnValue(false);
  const failure = new TimeoutFailure("expired", undefined, "HEARTBEAT");
  const acquireProductFile = vi.fn(async () => {
    throw failure;
  });
  const pipeline = { acquireProductFile } as unknown as PipelineActivities;
  const request = {} as never;
  const wrapped = withDownloadHeartbeat(pipeline, "files");
  expect(env.patch).not.toHaveBeenCalled();
  await expect(wrapped.acquireProductFile(request)).rejects.toBe(failure);
  expect(acquireProductFile).toHaveBeenCalledExactlyOnceWith(request);
  expect(env.proxy).not.toHaveBeenCalled();
});

it("registers a workflow-safe runtime code", () => {
  expect(activityErrors.create(activityCodes.heartbeatTimeout)).toMatchObject({
    code: "ACTIVITY.HEARTBEAT_TIMEOUT",
    category: "RUNTIME",
  });
});

it("recognizes heartbeat timeout metadata through the activity cause chain", async () => {
  const failure = new Error("Activity failed", {
    cause: new TimeoutFailure("unrelated message", undefined, "HEARTBEAT"),
  });
  expect(isHeartbeatTimeout(failure)).toBe(true);
  await expect(
    withHeartbeatFailure(async () => {
      throw failure;
    }),
  ).rejects.toMatchObject({
    type: activityCodes.heartbeatTimeout,
    nonRetryable: true,
  });
});

it.each([
  new TimeoutFailure("heartbeat timeout", undefined, "START_TO_CLOSE"),
  ApplicationFailure.nonRetryable("heartbeat timeout", "OCR.UNAVAILABLE"),
  new Error("heartbeat timeout"),
])("does not relabel another failure (%s)", async (failure) => {
  expect(isHeartbeatTimeout(failure)).toBe(false);
  await expect(
    withHeartbeatFailure(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});
