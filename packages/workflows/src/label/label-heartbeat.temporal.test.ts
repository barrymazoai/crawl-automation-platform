import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { activityCodes } from "@crawl-automation/platform/errors/activity";
import { gateBundle } from "../resources/testing/gate-bundles.js";
import { gateFixture } from "../resources/testing/gate-fixture.js";
import { entry, pageActivities } from "./label-fixture.js";

let environment: TestWorkflowEnvironment;
let workflowBundle: Awaited<ReturnType<typeof gateBundle>>;

beforeAll(async () => {
  workflowBundle = await gateBundle();
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await environment?.teardown();
});

function silentActivity() {
  let started: () => void = () => undefined;
  let stopped: () => void = () => undefined;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stop = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const attempts: number[] = [];
  const activity = vi.fn(async () => {
    const context = Context.current();
    attempts.push(context.info.attempt);
    context.heartbeat("started");
    // Simulate a dead executor: after this first heartbeat there is no further progress or completion.
    started();
    await stop;
  });
  return { activity, running, stopped, attempts };
}

it.each([false, true])(
  "a label activity stops heartbeating → Review, no retry, no held permit (gated=%s)",
  async (gated) => {
    const queue = `label-heartbeat-${randomUUID()}`;
    const gate = gateFixture();
    const silent = silentActivity();
    const steps = pageActivities();
    const reviewLabelProduct = vi.fn(steps.reviewLabelProduct);
    const resolveTextReceipt = vi.fn(steps.resolveTextReceipt);
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      workflowBundle,
      taskQueue: queue,
      activities: {
        ...gate.activities,
        ...steps,
        reviewLabelProduct,
        resolveTextReceipt,
        interpretText: silent.activity,
      },
      maxHeartbeatThrottleInterval: "50 milliseconds",
      defaultHeartbeatThrottleInterval: "50 milliseconds",
    });
    await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("LabelWorkflow", {
        taskQueue: queue,
        workflowId: randomUUID(),
        args: [
          {
            ...entry,
            queues: { activities: queue, model: queue, ocr: queue },
            ...(gated
              ? {
                  resources: {
                    queue,
                    maxWaitSeconds: 10,
                    activities: { interpretText: [{ resourceId: "test-model", units: 1 }] },
                  },
                }
              : {}),
          },
        ],
      });
      try {
        await handle.signal("labelStreamSealed", { operationId: "label-1", status: "closed" });
        await silent.running;
        expect(gate.held.size).toBe(gated ? 1 : 0);
        await vi.waitFor(async () => {
          const description = await handle.describe();
          expect(
            description.raw.pendingActivities?.some((activity) => activity.lastHeartbeatTime),
          ).toBe(true);
        });
        await environment.sleep("31 seconds");
        expect(await handle.result()).toMatchObject({ status: "review", automaticRetry: false });
        expect(reviewLabelProduct).toHaveBeenCalledOnce();
        expect(reviewLabelProduct).toHaveBeenCalledWith(
          expect.objectContaining({
            failures: [
              { sourceId: "page", code: activityCodes.heartbeatTimeout, executionFact: "unknown" },
            ],
          }),
        );
        expect(silent.attempts).toEqual([1]);
        expect(resolveTextReceipt).not.toHaveBeenCalled();
        expect(gate.calls.released).toBe(gated ? 1 : 0);
        expect(gate.held.size).toBe(0);
        await assertHeartbeatHistory(handle);
      } finally {
        silent.stopped();
      }
    });
  },
  45_000,
);

async function assertHeartbeatHistory(
  handle: ReturnType<TestWorkflowEnvironment["client"]["workflow"]["getHandle"]>,
) {
  // Inspect the actual server event and scheduled policy; histories stay in memory.
  const history = await handle.fetchHistory();
  const scheduled = history.events?.flatMap((event) =>
    event.activityTaskScheduledEventAttributes?.activityType?.name === "interpretText"
      ? [event.activityTaskScheduledEventAttributes]
      : [],
  );
  expect(scheduled).toHaveLength(1);
  expect(Number(scheduled?.[0]?.heartbeatTimeout?.seconds)).toBe(30);
  expect(scheduled?.[0]?.retryPolicy?.maximumAttempts).toBe(1);
  const timedOut = history.events?.find((event) => event.activityTaskTimedOutEventAttributes);
  expect(timedOut).toMatchObject({
    activityTaskTimedOutEventAttributes: {
      failure: { timeoutFailureInfo: { timeoutType: 4 } }, // TIMEOUT_TYPE_HEARTBEAT.
    },
  });
}
