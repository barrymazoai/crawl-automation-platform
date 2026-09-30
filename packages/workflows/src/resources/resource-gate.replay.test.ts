import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it } from "vitest";
import { entry, pageActivities, textOutcome } from "../label/label-fixture.js";
import { gateBundle } from "./testing/gate-bundles.js";
import { captureReview, gateFixture, productInput } from "./testing/gate-fixture.js";

let environment: TestWorkflowEnvironment;
let current: Awaited<ReturnType<typeof gateBundle>>;
let legacy: Awaited<ReturnType<typeof gateBundle>>;

beforeAll(async () => {
  [current, legacy] = await Promise.all([gateBundle(), gateBundle(true)]);
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
