import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";
import { browserTaskQueue } from "@crawl-automation/platform/browser-routing";
import { SiteAnalysisSchema, type ResourceRequest } from "@crawl-automation/v3-contracts";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { currentBundle, type ReplayBundle } from "./testing/replay/bundles.js";
import { hasMarker, recordHistory } from "./testing/replay/history.js";
import { stopProofActivities } from "./testing/replay/permits.js";
let environment: TestWorkflowEnvironment;
let bundle: ReplayBundle;
beforeAll(async () => {
  bundle = await currentBundle();
  environment = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);
afterAll(async () => environment?.teardown());
it.each([false, true])(
  "replays the analysis marker, host gate and one attempt (failure=%s)",
  async (fails) => {
    const queue = browserTaskQueue("mini-ego-space-1");
    const held = new Set<string>();
    const analyzeSiteInBrowser = vi.fn(async () => {
      expect(held.size).toBe(1);
      if (fails) {
        throw ApplicationFailure.nonRetryable("simulated", "DTC.ANALYSIS_UNVERIFIED");
      }
      return { state: "completed" };
    });
    const analysis = SiteAnalysisSchema.parse({
      analysisId: randomUUID(),
      url: "https://shop.example/",
      limits: {},
      state: "queued",
      brands: [],
      archiveKeys: [],
      reasons: [],
    });
    const recorded = await recordHistory({
      environment,
      bundle,
      queue,
      workflow: "SiteAnalysisWorkflow",
      fails,
      input: {
        ...analysis,
        resources: {
          queue,
          activities: { analyzeSiteInBrowser: [{ resourceId: "mini-ego-space-1", units: 1 }] },
        },
      },
      activities: {
        ...stopProofActivities(held),
        analyzeSiteInBrowser,
        reserveResources: async ({ permitId }: ResourceRequest) => {
          held.add(permitId);
          return { permitId, status: "granted", reason: "available" };
        },
        releaseResources: async ({ permitId }: ResourceRequest) => {
          expect(held.delete(permitId)).toBe(true);
          return { permitId, status: "released", reason: "released" };
        },
      },
    });
    expect(hasMarker(recorded.history, "dtc-site-analysis-v1")).toBe(true);
    expect(hasMarker(recorded.history, "browser-resource-routing-v1")).toBe(true);
    expect(analyzeSiteInBrowser).toHaveBeenCalledOnce();
    expect(held.size).toBe(0);
    await Worker.runReplayHistory(
      { workflowBundle: bundle },
      recorded.history,
      recorded.workflowId,
    );
  },
  30_000,
);
