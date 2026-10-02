import { PostgresProductRunStore, PostgresBrandScans } from "@crawl-automation/adapters";
import type { AcceptedProductRun } from "@crawl-automation/app";
import type { Database, TemporalClient } from "@crawl-automation/platform";
import { afterEach, expect, it, vi } from "vitest";
import { ApiConfigSchema } from "./config.js";
import { productRuns } from "./queue-parts.js";
import fixture from "./fixtures/api-config.json" with { type: "json" };

afterEach(() => vi.restoreAllMocks());

function setup(kind: "single-brand" | "multi-brand" = "single-brand") {
  const catalogUrl = `https://shop.example/collections/${kind === "single-brand" ? "all" : "alpha"}`;
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
  const sources = vi
    .spyOn(PostgresBrandScans.prototype, "sources")
    .mockResolvedValue([{ ...run, url: catalogUrl, brandName: "Alpha", enabled: true }]);
  const accept = vi.spyOn(PostgresProductRunStore.prototype, "accept").mockResolvedValue(run);
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
            ...(kind === "single-brand"
              ? { catalogUrl }
              : {
                  kind,
                  brands: [
                    { brand: "Alpha", catalogUrl },
                    { brand: "Beta", catalogUrl: "https://shop.example/collections/beta" },
                  ],
                }),
          },
          {
            siteKey: "other.example",
            platform: "shopify",
            catalogUrl: "https://other.example/collections/all",
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
  const request = {
    kind: "product" as const,
    requestId: run.runId,
    sourceId: run.sourceId,
    url: run.url,
  };
  return { run, runs, request, start, accept, sources, catalogUrl, config };
}

it.each(["single-brand", "multi-brand"] as const)(
  "starts a configured %s DTC product with its stored source catalog",
  async (kind) => {
    const { run, runs, request, start, sources, catalogUrl, config } = setup(kind);
    expect(await runs.submit(request)).toBe(run.runId);
    expect(sources).toHaveBeenCalledExactlyOnceWith([run.sourceId]);
    expect(start).toHaveBeenCalledWith(
      "ProductPipelineWorkflow",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            channel: "dtc",
            capture: "browser",
            url: run.url,
            sourceId: run.sourceId,
            sourceUrl: catalogUrl,
            queues: config.pipeline.queues,
            resources: config.pipeline.channels.dtc?.resources,
          }),
        ],
      }),
    );
  },
);

it("rejects a product on another configured site before acceptance", async () => {
  const test = setup("multi-brand");
  await expect(
    test.runs.submit({ ...test.request, url: "https://other.example/products/sleep" }),
  ).rejects.toMatchObject({
    code: "CHANNEL.URL_REJECTED",
  });
  expect(test.accept).not.toHaveBeenCalled();
  expect(test.start).not.toHaveBeenCalled();
});

it.each(["missing", "wrong-brand", "wrong-name", "unknown-catalog"])(
  "refuses %s source context before accepting the product",
  async (failure) => {
    const test = setup("multi-brand");
    test.sources.mockResolvedValue(
      failure === "missing"
        ? []
        : [
            {
              ...test.run,
              brandId: failure === "wrong-brand" ? "another-brand" : test.run.brandId,
              url:
                failure === "unknown-catalog"
                  ? "https://shop.example/collections/unknown"
                  : test.catalogUrl,
              brandName: failure === "wrong-name" ? "Beta" : "Alpha",
              enabled: true,
            },
          ],
    );
    await expect(test.runs.submit(test.request)).rejects.toHaveProperty("code");
    expect(test.accept).not.toHaveBeenCalled();
    expect(test.start).not.toHaveBeenCalled();
  },
);
