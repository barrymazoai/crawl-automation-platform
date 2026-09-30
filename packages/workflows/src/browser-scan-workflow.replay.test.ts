import { randomUUID } from "node:crypto";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { currentBundle, type ReplayBundle } from "./testing/replay/bundles.js";
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
      bundle: current,
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
