import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it } from "vitest";
import { withoutPatches } from "../testing/replay/bundles.js";
import { hasMarker, recordHistory, scheduledActivities } from "../testing/replay/history.js";
import { gateBundle } from "./testing/gate-bundles.js";
import { gateFixture } from "./testing/gate-fixture.js";

const marker = "browser-resource-outage-wait-v1";
let environment: TestWorkflowEnvironment;
let current: Awaited<ReturnType<typeof gateBundle>>;
beforeAll(async () => {
  current = await gateBundle();
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);
afterAll(async () => {
  await environment?.teardown();
});

it.each([false, true])("replays browser outage waiting with marker=%s", async (enabled) => {
  const fixture = gateFixture();
  let attempts = 0;
  const queue = `outage-${randomUUID()}`;
  const { history, workflowId } = await recordHistory({
    environment,
    bundle: enabled ? current : withoutPatches(current, [marker]),
    workflow: "GateScenarioWorkflow",
    queue,
    input: { queue, mode: "complete" },
    fails: !enabled,
    activities: {
      ...fixture.activities,
      reserveResources: async (request: { permitId: string }) => {
        attempts++;
        return {
          permitId: request.permitId,
          status: attempts < 4 ? "waiting" : "granted",
          reason: attempts < 4 ? "browser:BROWSER.UNAVAILABLE" : "available",
        };
      },
    },
  });
  expect(attempts).toBe(enabled ? 4 : 2);
  expect(scheduledActivities(history).filter((name) => name === "work")).toHaveLength(
    enabled ? 1 : 0,
  );
  expect(hasMarker(history, marker)).toBe(enabled);
  await Worker.runReplayHistory({ workflowBundle: current }, history, workflowId);
});
