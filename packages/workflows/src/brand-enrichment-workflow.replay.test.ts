import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";
import { browserTaskQueue } from "@crawl-automation/platform/browser-routing";
import {
  BrandEnrichmentWorkflowSettingsSchema,
  type ResourceRequest,
} from "@crawl-automation/v3-contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { currentBundle, withoutPatches, type ReplayBundle } from "./testing/replay/bundles.js";
import { hasMarker, recordHistory, scheduledActivities } from "./testing/replay/history.js";
import { stopProofActivities } from "./testing/replay/permits.js";

describe.skipIf(process.env["BRAND_ENRICHMENT_TEMPORAL_TEST"] !== "1")(
  "brand enrichment replay",
  () => {
    let environment: TestWorkflowEnvironment;
    let bundle: ReplayBundle;
    beforeAll(async () => {
      bundle = await currentBundle();
      environment = await TestWorkflowEnvironment.createTimeSkipping();
    }, 60_000);
    afterAll(async () => environment?.teardown());
    it.each([
      { legacy: false, existing: true },
      { legacy: true, existing: true },
      { legacy: true, existing: undefined },
    ])(
      "replays found completion and pre-patch commands (%j)",
      async ({ legacy, existing }) => {
        const queue = browserTaskQueue("mini-ego-space-1");
        const marker = "brand-enrichment-found-stops-v1";
        const held = new Set<string>();
        const close = vi.fn(async () => undefined);
        const recorded = await recordHistory({
          environment,
          bundle: legacy ? withoutPatches(bundle, [marker]) : bundle,
          queue,
          workflow: "BrandEnrichmentWorkflow",
          input: { runId: randomUUID(), settings: settingsFor(queue) },
          activities: {
            ...stopProofActivities(held),
            reserveResources: async ({ permitId }: ResourceRequest) => {
              held.add(permitId);
              return { permitId, status: "granted", reason: "available" };
            },
            releaseResources: async ({ permitId }: ResourceRequest) => {
              held.delete(permitId);
              return { permitId, status: "released", reason: "released" };
            },
            brandIdentity: async () => ({ role: "request", hasWebsite: true, existing }),
            brandFamily: async () => ({ children: [], products: false }),
            brandResearch: async () => undefined,
            brandApollo: async () => undefined,
            brandWrite: async () => undefined,
            brandContacts: async () => undefined,
            brandReview: async () => ({}),
            brandOwnershipWrite: async () => undefined,
            brandClose: close,
          },
        });
        expect(hasMarker(recorded.history, marker)).toBe(!legacy);
        const activities = scheduledActivities(recorded.history).filter((name) =>
          name.startsWith("brand"),
        );
        if (legacy) {
          // Research and Apollo run side by side, each after its own permit: their order varies between runs.
          expect(activities.slice(0, 2)).toEqual(["brandIdentity", "brandFamily"]);
          expect(new Set(activities.slice(2, 4))).toEqual(
            new Set(["brandResearch", "brandApollo"]),
          );
          expect(activities.slice(4)).toEqual([
            "brandWrite",
            "brandContacts",
            "brandReview",
            "brandOwnershipWrite",
            "brandClose",
          ]);
        } else {
          expect(activities).toEqual(["brandIdentity", "brandClose"]);
        }
        expect(close).toHaveBeenCalledWith(expect.objectContaining({ state: "completed" }));
        expect(held.size).toBe(0);
        await Worker.runReplayHistory(
          { workflowBundle: bundle },
          recorded.history,
          recorded.workflowId,
        );
      },
      60_000,
    );
    it.each([false, true])(
      "settles each unique permit, never retries, and replays (research failure=%s)",
      async (fails) => {
        const queue = browserTaskQueue("mini-ego-space-1");
        const held = new Set<string>();
        const allocated = new Set<string>();
        const settings = settingsFor(queue);
        const close = vi.fn(async () => undefined);
        const research = vi.fn(async () => {
          if (fails) {
            throw ApplicationFailure.nonRetryable("research failed", "BRAND_RESEARCH.UNVERIFIED");
          }
        });
        const recorded = await recordHistory({
          environment,
          bundle,
          queue,
          workflow: "BrandEnrichmentWorkflow",
          fails,
          input: { runId: randomUUID(), settings },
          activities: {
            ...stopProofActivities(held),
            reserveResources: async ({ permitId }: ResourceRequest) => {
              expect(allocated.has(permitId)).toBe(false);
              allocated.add(permitId);
              held.add(permitId);
              return { permitId, status: "granted", reason: "available" };
            },
            releaseResources: async ({ permitId }: ResourceRequest) => {
              expect(held.delete(permitId)).toBe(true);
              return { permitId, status: "released", reason: "released" };
            },
            brandIdentity: async () => ({ role: "request", hasWebsite: true }),
            brandFamily: async () => ({ children: [], products: true }),
            brandResearch: research,
            brandApollo: async () => undefined,
            brandProducts: async () => ({ done: true }),
            brandProductsStop: async () => undefined,
            brandWrite: async () => undefined,
            brandContacts: async () => undefined,
            brandReview: async () => ({}),
            brandOwnershipWrite: async () => undefined,
            brandClose: close,
          },
        });
        expect(research).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledWith(
          expect.objectContaining({ state: fails ? "failed" : "completed" }),
        );
        expect(held.size).toBe(0);
        expect(
          scheduledActivities(recorded.history).filter((name) => name === "brandResearch"),
        ).toHaveLength(1);
        await Worker.runReplayHistory(
          { workflowBundle: bundle },
          recorded.history,
          recorded.workflowId,
        );
      },
      60_000,
    );
  },
);

function settingsFor(queue: string) {
  const needs = [{ resourceId: "mini-model-account", units: 1 }];
  const browserNeeds = [{ resourceId: "mini-ego-space-1", units: 1 }, ...needs];
  return BrandEnrichmentWorkflowSettingsSchema.parse({
    taskQueue: queue,
    queues: { activities: queue, model: queue, browser: queue },
    resources: {
      queue,
      activities: {
        brandFamily: browserNeeds,
        brandResearch: browserNeeds,
        brandApollo: needs,
        brandContacts: needs,
        brandReview: needs,
      },
    },
  });
}
