import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  currentBundle,
  labelMarkers,
  labelPageVerdictMarker,
  withoutPatches,
  type ReplayBundle,
} from "../testing/replay/bundles.js";
import { expectMarkers, recordHistory, scheduledActivities } from "../testing/replay/history.js";
import { labelFallbackFixture } from "../testing/replay/label-fallback-fixture.js";
import { collected } from "./label-fixture.js";

let environment: TestWorkflowEnvironment;
let current: ReplayBundle;
let recording: ReplayBundle;

beforeAll(async () => {
  [current, recording] = await Promise.all([
    currentBundle(),
    bundleWorkflowCode({
      workflowsPath: fileURLToPath(
        new URL("../testing/replay/label-fallback-parent.ts", import.meta.url),
      ),
    }),
  ]);
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await environment?.teardown();
});

it.each([true, false])(
  "replays a page parser failure (pre-patch history: %s)",
  async (legacy) => {
    const queue = `label-verdict-${randomUUID()}`;
    const fixture = await labelFallbackFixture(queue);
    const childId = `label-${randomUUID()}`;
    const bundle = legacy ? withoutPatches(recording, [labelPageVerdictMarker]) : recording;
    const { result } = await recordHistory({
      environment,
      bundle,
      queue,
      workflow: "LabelFallbackParent",
      input: { childId, entry: fixture.input, file: fixture.file },
      activities: {
        ...fixture.activities,
        inspectLabelImage: async (
          request: Parameters<typeof fixture.activities.inspectLabelImage>[0],
        ) => {
          const result = await fixture.activities.inspectLabelImage(request);
          const { failures: _newField, ...previous } = result;
          return legacy ? previous : result;
        },
      },
    });
    expect(result).toMatchObject(
      legacy ? { status: "review", code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED" } : collected,
    );
    const history = await environment.client.workflow.getHandle(childId).fetchHistory();
    expectMarkers(history, legacy ? [...labelMarkers] : [...labelMarkers, labelPageVerdictMarker]);
    const activities = scheduledActivities(history);
    expect(activities.filter((name) => name === "prepareLabelCore")).toHaveLength(1);
    expect(activities.filter((name) => name === "interpretImage")).toHaveLength(legacy ? 0 : 1);
    expect(activities).not.toContain("interpretText");
    if (legacy) {
      expect(JSON.stringify(history)).not.toContain(labelPageVerdictMarker);
      expect(activities).toEqual([
        "loadLabelPlan",
        "prepareHtmlPage",
        "preparePageText",
        "prepareLabelCore",
        "inspectLabelImage",
        "reviewLabelProduct",
      ]);
    } else {
      expect(activities.indexOf("prepareImageOcr")).toBeGreaterThan(
        activities.indexOf("prepareLabelCore"),
      );
    }
    await Worker.runReplayHistory({ workflowBundle: current }, history, childId);
  },
  30_000,
);
