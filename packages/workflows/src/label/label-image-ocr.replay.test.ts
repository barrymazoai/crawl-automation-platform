import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it } from "vitest";
import { currentBundle, withoutPatches, type ReplayBundle } from "../testing/replay/bundles.js";
import { hasMarker, recordHistory, scheduledActivities } from "../testing/replay/history.js";
import { ocrFailureMarker, ocrWalkFixture } from "./ocr-walk-fixture.js";

let environment: TestWorkflowEnvironment;
let current: ReplayBundle;
let recording: ReplayBundle;

beforeAll(async () => {
  [current, recording] = await Promise.all([
    currentBundle(),
    bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("./ocr-replay-workflows.ts", import.meta.url)),
    }),
  ]);
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await environment?.teardown();
});

it.each([
  { legacy: true, mode: "timeout" },
  { legacy: false, mode: "timeout" },
  { legacy: false, mode: "transport" },
  { legacy: false, mode: "unreachable" },
] as const)(
  "replays OCR failure classification %j",
  async ({ legacy, mode }) => {
    const queue = `ocr-failure-${randomUUID()}`;
    const fixture = await ocrWalkFixture(queue, mode);
    const childId = `ocr-label-${randomUUID()}`;
    const bundle = legacy ? withoutPatches(recording, [ocrFailureMarker]) : recording;
    const { result } = await recordHistory({
      environment,
      bundle,
      queue,
      workflow: "OcrFailureParent",
      input: { childId, entry: fixture.input, files: fixture.files },
      activities: fixture.activities,
    });
    expect(result).toMatchObject({ status: "review", automaticRetry: false });
    const history = await environment.client.workflow.getHandle(childId).fetchHistory();
    expect(hasMarker(history, ocrFailureMarker)).toBe(!legacy);
    const expected = legacy || mode === "unreachable" ? 1 : 2;
    const activities = scheduledActivities(history);
    expect(activities.filter((name) => name === "ocrFile")).toHaveLength(expected);
    expect(activities.filter((name) => name === "resolveOcrReceipt")).toHaveLength(expected);
    expect(activities).not.toContain("interpretImage");
    const requests = (history.events ?? []).flatMap((event) => {
      const scheduled = event.activityTaskScheduledEventAttributes;
      if (scheduled?.activityType?.name !== "ocrFile") {
        return [];
      }
      return (
        scheduled.input?.payloads?.map((payload) =>
          JSON.parse(Buffer.from(payload.data ?? []).toString()),
        ) ?? []
      );
    });
    expect(requests).toEqual(
      fixture.tasks
        .slice(0, expected)
        .map((input) => (legacy ? input : { input, verifiedFailure: true })),
    );
    await Worker.runReplayHistory({ workflowBundle: current }, history, childId);
  },
  30_000,
);

const historyPath = process.env["CRAWLER_OCR_VERIFIED_FAILURE_REPLAY_HISTORY"];
it.skipIf(!historyPath)(
  "replays an owner-supplied pre-patch production history",
  async () => {
    const history = JSON.parse(await readFile(historyPath ?? "", "utf8"));
    expect(JSON.stringify(history)).not.toContain(ocrFailureMarker);
    await Worker.runReplayHistory({ workflowBundle: current }, history);
  },
  60_000,
);
