import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { withoutPatches } from "../testing/replay/bundles.js";
import {
  hasMarker,
  recordHistory,
  scheduledActivities,
  type History,
} from "../testing/replay/history.js";
import { gateBundle } from "./testing/gate-bundles.js";
import { gateFixture } from "./testing/gate-fixture.js";

const marker = "resource-reserve-failure-release-v1";
let environment: TestWorkflowEnvironment;
let current: Awaited<ReturnType<typeof gateBundle>>;
beforeAll(async () => {
  current = await gateBundle();
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);
afterAll(async () => {
  await environment?.teardown();
});

function scenarioFixture(mode: string) {
  const fixture = gateFixture();
  const reserve = vi.fn(async (request: { permitId: string }) => {
    fixture.held.add(request.permitId);
    if (mode === "timeout") {
      await setTimeout(11_000);
    }
    throw new Error("reserve reply lost after commit");
  });
  const release = vi.fn(fixture.activities.releaseResources);
  if (mode === "release-failure") {
    release.mockRejectedValue(new Error("release unavailable"));
  }
  return { ...fixture, reserve, release };
}

function expectCleanup(
  scenario: { enabled: boolean; mode: string },
  fixture: ReturnType<typeof scenarioFixture>,
) {
  expect(fixture.reserve).toHaveBeenCalledOnce();
  expect(fixture.calls.work).toBe(0);
  if (scenario.enabled) {
    expect(fixture.release).toHaveBeenCalledTimes(scenario.mode === "release-failure" ? 3 : 1);
    expect(fixture.release.mock.calls[0]?.[0]).toEqual({
      ...fixture.reserve.mock.calls[0]?.[0],
      reserveFailed: true,
    });
  } else {
    expect(fixture.release).not.toHaveBeenCalled();
  }
  expect(fixture.held.size).toBe(scenario.enabled && scenario.mode !== "release-failure" ? 0 : 1);
}

function expectReserveFailure(history: History, mode: string) {
  const failure = history.events?.at(-1)?.workflowExecutionFailedEventAttributes?.failure;
  expect(failure).toMatchObject({
    activityFailureInfo: { activityType: { name: "reserveResources" } },
    cause:
      mode === "timeout"
        ? { timeoutFailureInfo: { timeoutType: 1 } }
        : { message: "reserve reply lost after commit" },
  });
}

it.each([
  { enabled: false, mode: "failure" },
  { enabled: true, mode: "failure" },
  { enabled: true, mode: "timeout" },
  { enabled: true, mode: "release-failure" },
])(
  "replays reserve $mode with failure-release marker=$enabled",
  async ({ enabled, mode }) => {
    const fixture = scenarioFixture(mode);
    const queue = `reserve-replay-${randomUUID()}`;
    const { history, workflowId } = await recordHistory({
      environment,
      bundle: enabled ? current : withoutPatches(current, [marker]),
      workflow: "GateScenarioWorkflow",
      queue,
      input: { queue, mode: "complete" },
      fails: true,
      activities: {
        ...fixture.activities,
        reserveResources: fixture.reserve,
        releaseResources: fixture.release,
      },
    });
    expectCleanup({ enabled, mode }, fixture);
    expect(scheduledActivities(history)).toEqual([
      "reserveResources",
      ...(enabled ? ["releaseResources"] : []),
    ]);
    expect(hasMarker(history, marker)).toBe(enabled);
    expectReserveFailure(history, mode);
    await Worker.runReplayHistory({ workflowBundle: current }, history, workflowId);
  },
  30_000,
);
