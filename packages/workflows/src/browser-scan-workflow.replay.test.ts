import { randomUUID } from "node:crypto";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { ResourceRequest } from "@crawl-automation/v3-contracts";
import { currentBundle, withoutPatches, type ReplayBundle } from "./testing/replay/bundles.js";
import { expectMarkers, recordHistory, scheduledActivities } from "./testing/replay/history.js";

let environment: TestWorkflowEnvironment;
let current: ReplayBundle;

beforeAll(async () => {
  current = await currentBundle();
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await environment?.teardown();
});

// Widening the schema leaves old payloads intact; replay both legacy and explicit-capability inputs.
it.each(
  [false, true].flatMap((fails) => [
    { fails, channel: "wholefoods", capture: undefined },
    { fails, channel: "wholefoods", capture: "browser" },
    { fails, channel: "dtc", capture: "browser" },
    { fails, channel: "dtc", capture: "browser", sourceId: "22222222-2222-4222-8222-222222222222" },
  ]),
)(
  "replays BrowserScanWorkflow ($channel, capture: $capture, fails: $fails)",
  async (scenario) => {
    const { fails, channel, capture } = scenario;
    const sourceId = "sourceId" in scenario ? scenario.sourceId : undefined;
    const queue = `scan-replay-${randomUUID()}`;
    const input = {
      channel,
      ...(capture ? { capture } : {}),
      ...(sourceId ? { sourceId } : {}),
      scanId: "scan-1",
      sourceUrl: "https://example.com/brand",
    };
    const outcome = { status: "completed", listings: ["listing-1"] };
    const scanBrandInBrowser = vi.fn(async (_input: unknown) => {
      if (fails) {
        throw ApplicationFailure.nonRetryable("Simulated scan failure", "BROWSER.SCAN_FAILED");
      }
      return outcome;
    });
    const { history, result, workflowId } = await recordHistory({
      environment,
      bundle: withoutPatches(current, ["browser-scan-permit-v1"]),
      queue,
      workflow: "BrowserScanWorkflow",
      input,
      activities: { scanBrandInBrowser },
      fails,
    });
    if (!fails) {
      expect(result).toEqual(outcome);
    }
    expect(scanBrandInBrowser).toHaveBeenCalledExactlyOnceWith(input);
    expectMarkers(history, []);
    expect(scheduledActivities(history)).toEqual(["scanBrandInBrowser"]);
    await Worker.runReplayHistory({ workflowBundle: current }, history, workflowId);
  },
  30_000,
);

it.each(["complete", "broken", "throttled", "failure"])(
  "replays a gated %s scan with its gap or cool-down before release",
  async (ending) => {
    const queue = `paced-scan-${randomUUID()}`;
    const input = {
      channel: "wholefoods",
      capture: "browser",
      scanId: "scan-paced",
      sourceUrl: "https://example.com/brand",
      gapAfterSeconds: 1,
      cooldownSeconds: 2,
      resources: {
        queue,
        maxWaitSeconds: 10,
        activities: { scanBrandInBrowser: [{ resourceId: "wholefoods-brand-scan", units: 1 }] },
      },
    };
    const held = new Set<string>();
    const scanBrandInBrowser = vi.fn(async () => {
      expect(held.size).toBe(1);
      if (ending === "throttled" || ending === "failure") {
        throw ApplicationFailure.nonRetryable("unresolved", "WHOLEFOODS.SEARCH_THROTTLED", {
          cooldownRequested: ending === "throttled",
        });
      }
      return { complete: ending === "complete", cooldownRequested: ending === "broken" };
    });
    const reserveResources = async ({ permitId }: ResourceRequest) => {
      held.add(permitId);
      return { permitId, status: "granted", reason: "available" };
    };
    const releaseResources = async ({ permitId }: ResourceRequest) => {
      expect(held.delete(permitId)).toBe(true);
      return { permitId, status: "released", reason: "released" };
    };
    const { history, workflowId } = await recordHistory({
      environment,
      bundle: current,
      queue,
      workflow: "BrowserScanWorkflow",
      input,
      activities: { scanBrandInBrowser, reserveResources, releaseResources },
      fails: ending === "throttled" || ending === "failure",
    });
    expect(held.size).toBe(0);
    expect(scanBrandInBrowser).toHaveBeenCalledOnce();
    expectMarkers(history, ["browser-scan-permit-v1"]);
    expect(scheduledActivities(history)).toEqual([
      "reserveResources",
      "scanBrandInBrowser",
      "releaseResources",
    ]);
    const events = history.events ?? [];
    const timers = events.filter((event) => event.timerStartedEventAttributes);
    expect(timers).toHaveLength(1);
    expect(Number(timers[0]?.timerStartedEventAttributes?.startToFireTimeout?.seconds)).toBe(
      ending === "broken" || ending === "throttled" ? 2 : 1,
    );
    const released = events.findIndex(
      (event) =>
        event.activityTaskScheduledEventAttributes?.activityType?.name === "releaseResources",
    );
    expect(released).toBeGreaterThan(events.findIndex((event) => event.timerFiredEventAttributes));
    await Worker.runReplayHistory({ workflowBundle: current }, history, workflowId);
  },
  30_000,
);
