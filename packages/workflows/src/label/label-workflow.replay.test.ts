import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it } from "vitest";
import { entry, collected, pageActivities, textOutcome } from "./label-fixture.js";
import { gateFixture } from "../resources/testing/gate-fixture.js";
import {
  currentBundle,
  labelMarkers,
  withoutPatches,
  type PatchMarker,
  type ReplayBundle,
} from "../testing/replay/bundles.js";
import {
  expectMarkers,
  heartbeatSeconds,
  recordHistory,
  scheduledActivities,
  type History,
} from "../testing/replay/history.js";

let environment: TestWorkflowEnvironment;
let current: ReplayBundle;
const recordingBundles = new Map<string, ReplayBundle>();
const versions = [
  { name: "all markers present", missing: [] },
  ...labelMarkers.map((marker) => ({ name: `without ${marker}`, missing: [marker] })),
  { name: "before both patches", missing: [...labelMarkers] },
] satisfies Array<{ name: string; missing: PatchMarker[] }>;

beforeAll(async () => {
  current = await currentBundle();
  for (const version of versions) {
    recordingBundles.set(version.name, withoutPatches(current, version.missing));
  }
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await environment?.teardown();
});

const cases = versions.flatMap((version) =>
  (["closed", "failed"] as const).map((seal) => ({ ...version, seal })),
);

it.each(cases)(
  "replays LabelWorkflow $name (stream: $seal)",
  async ({ name, missing, seal }) => {
    const queue = `label-replay-${randomUUID()}`;
    const gate = gateFixture();
    const bundle = recordingBundles.get(name);
    if (!bundle) {
      throw new Error(`Missing recording bundle: ${name}`);
    }
    const { history, result, workflowId } = await recordHistory({
      environment,
      bundle,
      queue,
      workflow: "LabelWorkflow",
      input: {
        ...entry,
        queues: { activities: queue, model: queue, ocr: queue },
        resources: {
          queue,
          releaseOnReview: true,
          activities: { interpretText: [{ resourceId: "test-model", units: 1 }] },
        },
      },
      activities: {
        ...gate.activities,
        ...pageActivities(),
        interpretText: async () => textOutcome,
      },
      afterStart: (handle) =>
        handle.signal("labelStreamSealed", {
          operationId: entry.input.operationId,
          status: seal,
        }),
    });
    if (seal === "closed") {
      expect(result).toEqual(collected);
    } else {
      expect(result).toMatchObject({
        status: "review",
        code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
      });
    }
    expectMarkers(
      history,
      labelMarkers.filter((marker) => !missing.includes(marker)),
    );
    expectHeartbeats(history, missing);
    expectLostReceipt(history);
    const finish =
      seal === "closed"
        ? ["prepareLabelManifest", "assembleLabelProduct", "collectLabelProduct"]
        : ["reviewLabelProduct"];
    expect(scheduledActivities(history)).toEqual([
      "loadLabelPlan",
      "prepareHtmlPage",
      "preparePageText",
      "prepareLabelSource",
      "reserveResources",
      "interpretText",
      "releaseResources",
      "resolveTextReceipt",
      ...finish,
    ]);
    expect(gate.calls.reserved).toBe(1);
    expect(gate.calls.released).toBe(1);
    expect(gate.held.size).toBe(0);
    await Worker.runReplayHistory({ workflowBundle: current }, history, workflowId);
  },
  30_000,
);

function expectHeartbeats(history: History, missing: PatchMarker[]) {
  const labelHeartbeat = missing.includes("label-heartbeat-v1") ? 0 : 30;
  // R05 already supplies 30 seconds for gated activities, even before the label heartbeat patch.
  const gatedHeartbeat = missing.includes("resource-gate-v1") ? labelHeartbeat : 30;
  expect(heartbeatSeconds(history, "interpretText")).toEqual([gatedHeartbeat]);
  expect(heartbeatSeconds(history, "loadLabelPlan")).toEqual([labelHeartbeat]);
}

function expectLostReceipt(history: History) {
  // pageActivities deliberately loses the HTML receipt; page text uses its durable record.
  const failures = history.events?.flatMap((event) =>
    event.activityTaskFailedEventAttributes ? [event.activityTaskFailedEventAttributes] : [],
  );
  expect(failures).toHaveLength(1);
  const failed = history.events?.find(
    (event) => event.eventId?.toString() === failures?.[0]?.scheduledEventId?.toString(),
  );
  expect(failed?.activityTaskScheduledEventAttributes?.activityType?.name).toBe("prepareHtmlPage");
}
