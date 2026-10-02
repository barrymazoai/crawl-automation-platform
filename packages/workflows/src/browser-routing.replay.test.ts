import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { browserTaskQueue } from "@crawl-automation/platform/browser-routing";
import type { ResourceRequest } from "@crawl-automation/v3-contracts";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { currentBundle, withoutPatches, type ReplayBundle } from "./testing/replay/bundles.js";
import { hasMarker, recordHistory, scheduledActivities } from "./testing/replay/history.js";
import { captureReview, productInput } from "./resources/testing/gate-fixture.js";

const marker = "browser-resource-routing-v1";
const hosts = ["mini-ego-space-1", "server2-ego-space-6"] as const;
let environment: TestWorkflowEnvironment;
let current: ReplayBundle;
let legacy: ReplayBundle;

beforeAll(async () => {
  current = await currentBundle();
  legacy = withoutPatches(current, [marker]);
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);
afterAll(async () => environment?.teardown());

const cases = hosts.flatMap((host) =>
  [false, true].flatMap((enabled) => [
    {
      host,
      enabled,
      workflow: "BrowserScanWorkflow",
      activity: "scanBrandInBrowser",
      channel: "wholefoods",
    },
    {
      host,
      enabled,
      workflow: "BrowserScanWorkflow",
      activity: "scanBrandInBrowser",
      channel: "costco",
    },
    {
      host,
      enabled,
      workflow: "BrowserScanWorkflow",
      activity: "scanBrandInBrowser",
      channel: "dtc",
    },
    {
      host,
      enabled,
      workflow: "BrandListingWorkflow",
      activity: "readBrandListing",
      channel: "dtc",
    },
    {
      host,
      enabled,
      workflow: "ProductPipelineWorkflow",
      activity: "captureBrowserProduct",
      channel: "dtc",
    },
  ]),
);
type Scenario = (typeof cases)[number];

function inputFor(scenario: Scenario, queue: string) {
  const activity =
    scenario.activity === "captureBrowserProduct" ? "captureProduct" : scenario.activity;
  const resources = {
    queue,
    activities: { [activity]: [{ resourceId: scenario.host, units: 1 }] },
  };
  if (scenario.workflow === "ProductPipelineWorkflow") {
    return { ...productInput(queue, "dtc"), capture: "browser", resources };
  }
  const scanId = "22222222-2222-4222-8222-222222222222";
  return scenario.workflow === "BrowserScanWorkflow"
    ? { scanId, channel: scenario.channel, sourceUrl: "https://example.com/brand", resources }
    : {
        scanId,
        source: { sourceId: scanId, channel: "dtc", url: "https://example.com/brand" },
        resources,
      };
}

/** Both hosts poll, but only the selected queue can receive the business activity. */
it.each(cases)(
  "replays $workflow / $channel / $host with routing marker=$enabled",
  async (scenario) => {
    const queue = `routing-replay-${randomUUID()}`;
    const held = new Set<string>();
    const matching = vi.fn(async () => {
      expect(held.size).toBe(1);
      return captureReview();
    });
    const foreign = vi.fn(async () => {
      throw new Error("Foreign browser must never execute");
    });
    const workers = await Promise.all(
      hosts.map((host) =>
        Worker.create({
          connection: environment.nativeConnection,
          taskQueue: browserTaskQueue(host),
          activities: { [scenario.activity]: host === scenario.host ? matching : foreign },
        }),
      ),
    );
    const [serverOne, serverTwo] = workers;
    if (!serverOne || !serverTwo) {
      throw new Error("Both browser pollers are required");
    }
    const recorded = await serverOne.runUntil(() =>
      serverTwo.runUntil(() =>
        recordHistory({
          environment,
          queue,
          workflow: scenario.workflow,
          bundle: scenario.enabled ? current : legacy,
          input: inputFor(scenario, queue),
          activities: {
            [scenario.activity]: matching,
            reserveResources: async (request: ResourceRequest) => {
              expect(request.needs).toEqual([{ resourceId: scenario.host, units: 1 }]);
              held.add(request.permitId);
              return { permitId: request.permitId, status: "granted", reason: "available" };
            },
            releaseResources: async ({ permitId }: ResourceRequest) => {
              expect(held.delete(permitId)).toBe(true);
              return { permitId, status: "released", reason: "released" };
            },
          },
        }),
      ),
    );
    expect(matching).toHaveBeenCalledOnce();
    expect(foreign).not.toHaveBeenCalled();
    expect(held.size).toBe(0);
    expect(hasMarker(recorded.history, marker)).toBe(scenario.enabled);
    expect(scheduledActivities(recorded.history)).toEqual([
      "reserveResources",
      scenario.activity,
      "releaseResources",
    ]);
    const scheduled = recorded.history.events?.find(
      (event) =>
        event.activityTaskScheduledEventAttributes?.activityType?.name === scenario.activity,
    )?.activityTaskScheduledEventAttributes;
    expect(scheduled?.taskQueue?.name).toBe(
      scenario.enabled ? browserTaskQueue(scenario.host) : queue,
    );
    await Worker.runReplayHistory(
      { workflowBundle: current },
      recorded.history,
      recorded.workflowId,
    );
  },
  30_000,
);
