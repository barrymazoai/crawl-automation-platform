import { expect, it, vi } from "vitest";
vi.mock("./activity-guard.js", () => ({ guarded: (_name: string, handler: unknown) => handler }));
import { enrichmentPipelineActivities } from "./enrichment-activities.js";
import type { WorkerParts } from "../container.js";

it("uses the existing text model queue and its exact resource capacity", async () => {
  const needs = [{ resourceId: "model-account", units: 1 }];
  const parts = {
    config: {
      label: {
        shared: {
          queues: { model: "text-model" },
          resources: {
            queue: "resources",
            activities: { interpretText: needs },
            maxWaitSeconds: 900,
          },
        },
      },
    },
  } as unknown as WorkerParts;
  const route = await enrichmentPipelineActivities(parts).prepareProductEnrichment({});
  expect(route).toEqual({
    queue: "text-model",
    resources: {
      queue: "resources",
      activities: { enrichCollectedProduct: needs },
      maxWaitSeconds: 900,
    },
  });
});
it("refuses an unconfigured model permit instead of running ungated", async () => {
  const parts = { config: {} } as WorkerParts;
  await expect(
    enrichmentPipelineActivities(parts).prepareProductEnrichment({}),
  ).rejects.toMatchObject({ code: "ENRICH.SETTINGS_MISSING" });
});
