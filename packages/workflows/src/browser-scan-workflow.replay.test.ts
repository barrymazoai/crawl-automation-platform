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

// BrowserScanWorkflow has no patch points or versioned callees; both terminal outcomes are replayed.
it.each([false, true])(
  "replays BrowserScanWorkflow (activity fails: %s)",
  async (fails) => {
    const queue = `scan-replay-${randomUUID()}`;
    const input = {
      channel: "wholefoods",
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
