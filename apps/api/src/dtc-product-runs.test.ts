import { PostgresProductRunStore } from "@crawl-automation/adapters";
import type { AcceptedProductRun } from "@crawl-automation/app";
import type { Database, TemporalClient } from "@crawl-automation/platform";
import { afterEach, expect, it, vi } from "vitest";
import { ApiConfigSchema } from "./config.js";
import { productRuns } from "./queue-parts.js";
import fixture from "./fixtures/api-config.json" with { type: "json" };

afterEach(() => vi.restoreAllMocks());

it("starts a configured DTC product run with the adapter's browser capability", async () => {
  const run: AcceptedProductRun = {
    runId: "11111111-1111-4111-8111-111111111111",
    sourceId: "22222222-2222-4222-8222-222222222222",
    brandId: "33333333-3333-4333-8333-333333333333",
    workflowId: "product-run-11111111-1111-4111-8111-111111111111",
    channel: "dtc",
    url: "https://shop.example/products/sleep?variant=11",
    startedRunId: null,
  };
  vi.spyOn(PostgresProductRunStore.prototype, "source").mockResolvedValue(run);
  vi.spyOn(PostgresProductRunStore.prototype, "accept").mockResolvedValue(run);
  vi.spyOn(PostgresProductRunStore.prototype, "markStarted").mockResolvedValue();
  const start = vi.fn(async () => ({ firstExecutionRunId: "temporal-run" }));
  const config = ApiConfigSchema.parse({
    ...fixture,
    browser: {
      dtc: {
        sites: [
          {
            siteKey: "shop.example",
            platform: "shopify",
            catalogUrl: "https://shop.example/collections/all",
          },
        ],
      },
    },
    pipeline: {
      queues: { activities: "pipeline", plan: "plan", label: "label", browser: "browser" },
      channels: {
        dtc: {
          resources: {
            queue: "resource",
            activities: {
              captureProduct: [{ resourceId: "dtc-browser", units: 1 }],
            },
          },
        },
      },
    },
  });
  const runs = productRuns({
    database: {} as Database,
    temporal: {
      client: {
        workflow: { start },
        connection: { withDeadline: (_deadline: number, call: () => unknown) => call() },
      },
    } as unknown as TemporalClient,
    config,
  });
  expect(
    await runs.submit({
      kind: "product",
      requestId: run.runId,
      sourceId: run.sourceId,
      url: run.url,
    }),
  ).toBe(run.runId);
  expect(start).toHaveBeenCalledWith(
    "ProductPipelineWorkflow",
    expect.objectContaining({
      args: [
        expect.objectContaining({
          channel: "dtc",
          capture: "browser",
          url: run.url,
          queues: config.pipeline.queues,
          resources: config.pipeline.channels.dtc?.resources,
        }),
      ],
    }),
  );
});
