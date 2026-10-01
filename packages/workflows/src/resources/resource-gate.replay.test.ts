import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/common";
import { expectMarkers, recordHistory, scheduledActivities } from "../testing/replay/history.js";
import { entry, pageActivities, textOutcome } from "../label/label-fixture.js";
import { gateBundle } from "./testing/gate-bundles.js";
import { captureReview, gateFixture, productInput } from "./testing/gate-fixture.js";

let environment: TestWorkflowEnvironment;
let current: Awaited<ReturnType<typeof gateBundle>>;
let legacy: Awaited<ReturnType<typeof gateBundle>>;
let prior: Awaited<ReturnType<typeof gateBundle>>;

beforeAll(async () => {
  [current, legacy, prior] = await Promise.all([
    gateBundle(),
    gateBundle(true),
    gateBundle("prior"),
  ]);
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await environment?.teardown();
});

/** Histories originate in this test environment and stay in memory; none are fixtures on disk. */
it.each(["swanson", "wholefoods", "label"])(
  "replays the old %s gate against the patched code without changing commands",
  async (channel) => {
    const queue = `gate-replay-${randomUUID()}`;
    const fixture = gateFixture();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      workflowBundle: legacy,
      taskQueue: queue,
      activities: {
        ...fixture.activities,
        ...pageActivities(),
        interpretText: async () => textOutcome,
        captureProduct: async () => captureReview(),
        captureBrowserProduct: async () => captureReview(),
      },
    });
    await worker.runUntil(async () => {
      const label = channel === "label";
      const input = label ? labelInput(queue) : productInput(queue, channel);
      const handle = await environment.client.workflow.start(
        label ? "LabelWorkflow" : "ProductPipelineWorkflow",
        { taskQueue: queue, workflowId: randomUUID(), args: [input] },
      );
      if (label) {
        await handle.signal("labelStreamSealed", { operationId: "label-1", status: "closed" });
      }
      await handle.result();
      const history = await handle.fetchHistory();
      const markers =
        history.events?.flatMap((event) =>
          Object.values(event.markerRecordedEventAttributes?.details ?? {}).flatMap(
            (payloads) =>
              payloads.payloads?.map((payload) => Buffer.from(payload.data ?? []).toString()) ?? [],
          ),
        ) ?? [];
      expect(markers.some((marker) => marker.includes("resource-gate-v1"))).toBe(false);
      expect(fixture.calls.reserved).toBeGreaterThan(0);
      expect(fixture.held.size).toBe(0);
      await Worker.runReplayHistory({ workflowBundle: current }, history);
    });
  },
  30_000,
);

function labelInput(queue: string) {
  return {
    ...entry,
    queues: { activities: queue, model: queue, ocr: queue },
    resources: {
      queue,
      releaseOnReview: true,
      activities: {
        interpretText: [{ resourceId: "test-model", units: 1 }],
      },
    },
  };
}

it("replays resource-gate-v1 history from before executor proof without new commands", async () => {
  const queue = `gate-prior-${randomUUID()}`;
  const fixture = gateFixture();
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    workflowBundle: prior,
    taskQueue: queue,
    activities: fixture.activities,
  });
  await worker.runUntil(async () => {
    const handle = await environment.client.workflow.start("GateScenarioWorkflow", {
      taskQueue: queue,
      workflowId: randomUUID(),
      args: [{ queue, mode: "complete" }],
    });
    await handle.result();
    const history = await handle.fetchHistory();
    expect(fixture.held.size).toBe(0);
    await Worker.runReplayHistory({ workflowBundle: current }, history);
  });
}, 30_000);

it.each([
  { legacy: true, stopped: true, fails: false },
  { legacy: true, stopped: true, fails: true },
  { legacy: false, stopped: true, fails: false },
  { legacy: false, stopped: true, fails: true },
  { legacy: false, stopped: false, fails: false },
])(
  "replays unknown execution (legacy=$legacy, stopped=$stopped, fails=$fails)",
  async (scenario) => {
    const queue = `gate-unknown-${randomUUID()}`;
    const fixture = gateFixture();
    let workCalls = 0;
    const { history, workflowId } = await recordHistory({
      environment,
      bundle: scenario.legacy ? prior : current,
      queue,
      workflow: "GateScenarioWorkflow",
      input: { queue, mode: "complete" },
      fails: scenario.fails || !scenario.stopped,
      activities: {
        ...fixture.activities,
        work: async () => {
          workCalls++;
          if (scenario.fails) {
            throw ApplicationFailure.nonRetryable("lost answer", "OCR.RESPONSE_UNKNOWN", {
              executionFact: "unknown",
            });
          }
          return { status: "review", executionFact: "unknown" };
        },
        stopResourceExecution: async ({ permitId }: { permitId: string }) => ({
          permitId,
          state: scenario.stopped ? "stopped" : "unknown",
          attempts: 1,
        }),
      },
    });
    expect(workCalls).toBe(1);
    expectMarkers(history, [
      "resource-gate-v1",
      ...(scenario.legacy ? [] : (["resource-execution-stop-proof-v1"] as const)),
    ]);
    const commands = scheduledActivities(history);
    const checks = commands.filter((name) => name === "stopResourceExecution").length;
    expect(checks).toBeLessThanOrEqual(31);
    expect(checks).toBeGreaterThanOrEqual(scenario.legacy ? 0 : 1);
    expect(commands).toEqual([
      "reserveResources",
      "work",
      ...Array.from(
        { length: scenario.legacy ? 0 : scenario.stopped ? 1 : checks },
        () => "stopResourceExecution",
      ),
      ...(scenario.stopped ? ["releaseResources"] : []),
    ]);
    expect(fixture.held.size).toBe(scenario.stopped ? 0 : 1);
    await Worker.runReplayHistory({ workflowBundle: current }, history, workflowId);
  },
  30_000,
);
