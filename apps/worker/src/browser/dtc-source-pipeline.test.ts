import { afterEach, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", () => ({
  Context: {
    current: () => ({
      info: { attempt: 1, workflowExecution: { workflowId: "product", runId: "execution" } },
      heartbeat: vi.fn(),
      cancellationSignal: new AbortController().signal,
    }),
  },
}));
vi.mock("../capture-records.js", () => ({
  captureRecords: () => ({ listings: { record: vi.fn() }, history: { record: vi.fn() } }),
}));

import {
  ProductRuns,
  QueueDispatcher,
  type DispatchStore,
  type ScanSource,
} from "@crawl-automation/app";
import { ProductPlans, planKey } from "@crawl-automation/channels-core";
import {
  EgoPages,
  RetainedPublication,
  createLogger,
  verifyBytes,
  type ObjectStore,
} from "@crawl-automation/platform";
import { ChannelProductPlanSchema, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { BrowserCaptureResultSchema, type ProductPipelineInput } from "@crawl-automation/workflows";
import { browserActivities } from "../activities/browser-activities.js";
import { pipelineActivities } from "../activities/pipeline-activities.js";
import { workerChannelRegistry } from "../channel-registry.js";
import type { WorkerParts } from "../container.js";
import type { CoreParts } from "../core-parts.js";
import { buildBrowserParts } from "./browser-parts.js";
import { BrowserSettingsSchema } from "./browser-settings.js";

const origin = "https://shop.example";
const url = `${origin}/products/sleep`;
const alphaUrl = `${origin}/collections/alpha`;
const betaUrl = `${origin}/collections/beta`;
const brandId = "11111111-1111-4111-8111-111111111111";
const sourceIds = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const runIds = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
const log = createLogger({ name: "dtc-pipeline-test", destination: { write: () => undefined } });
const html = `<link rel="canonical" href="${url}"><main><h1>Sleep</h1>
<script type="application/ld+json">${JSON.stringify({
  "@type": "Product",
  name: "Sleep",
  sku: "123",
  url,
  brand: { name: "Beta" },
  description: "Serving Size: 2 capsules. Magnesium 100 mg. Other Ingredients: cellulose.",
  offers: { price: "12.50", priceCurrency: "USD" },
})}</script></main>`;

function memoryStore(): ObjectStore {
  const data = new Map<string, Uint8Array>();
  return {
    read: async (key) => data.get(key) ?? null,
    create: async (key, bytes) => {
      if (data.has(key)) {
        return "exists";
      }
      data.set(key, Buffer.from(bytes));
      return "created";
    },
  };
}

function setup(single = false) {
  const browser = BrowserSettingsSchema.parse({
    ego: { cliPath: "/tmp/not-executed-ego", taskSpaceId: 1 },
    wholefoods: { storeId: "10259", label: "Test", postalCode: "95126" },
    dtc: {
      sites: [
        {
          siteKey: "shop.example",
          platform: "jsonld",
          ...(single
            ? { catalogUrl: alphaUrl }
            : {
                kind: "multi-brand",
                brands: [
                  { brand: "Alpha", catalogUrl: alphaUrl },
                  { brand: "Beta", catalogUrl: betaUrl },
                ],
              }),
        },
      ],
    },
  });
  const compatibility = {
    schemaVersion: 1,
    implementationVersion: "test/1",
    policyVersion: "test/1",
    resultSchemaVersion: 2,
    configFingerprint: "a".repeat(64),
  };
  const config = {
    browser,
    plan: {
      text: { ...compatibility, module: "codex.text" },
      ocr: { ...compatibility, module: "ocr.file" },
      visionConfigFingerprint: "b".repeat(64),
      factsPolicy: "text-facts-first/1",
    },
  };
  const publication = new RetainedPublication(memoryStore(), memoryStore());
  const registry = workerChannelRegistry(config);
  const records = new Map<string, ReviewRecord>();
  const channelPlans = new ProductPlans({
    registry,
    publication,
    resolver: {
      resolve: async (ref) => ({
        ref,
        bytes:
          (await publication.remote.read(
            ref.objectKey,
            ref.byteSize,
            new AbortController().signal,
          )) ?? new Uint8Array(),
      }),
    },
    reviews: {
      read: async (id) => records.get(id) ?? null,
      append: async (record) => {
        records.set(record.reviewId, record);
      },
    },
    integrity: { verifyBytes },
  });
  const core = {
    config,
    registry,
    publication,
    log,
    fileTransport: { egressId: "test-files" },
  } as unknown as CoreParts;
  const parts = { ...core, browser: buildBrowserParts(core), channelPlans } as WorkerParts;
  const read = vi.spyOn(EgoPages.prototype, "read").mockResolvedValue({
    url,
    html,
    status: 200,
    ready: true,
    scroll: { rounds: 0, ended: "none" },
  });
  return { parts, read, publication, records };
}

async function queuedInputs(parts: WorkerParts, catalogs = [alphaUrl, betaUrl]) {
  const sources: ScanSource[] = catalogs.map((catalog, index) => ({
    sourceId: sourceIds[index] ?? "",
    brandId,
    channel: "dtc",
    url: catalog,
    brandName: index === 0 ? "Alpha" : "Beta",
    enabled: true,
  }));
  const start = vi.fn(async (_id: string, _input: ProductPipelineInput) => ({
    startedRunId: "started",
  }));
  const runs = new ProductRuns({
    store: {
      source: async () => ({ brandId, channel: "dtc" }),
      accept: async (run) => ({
        ...run,
        runId: run.requestId,
        workflowId: `product-run-${run.requestId}`,
        startedRunId: null,
      }),
      markStarted: vi.fn(),
    },
    sources: { sources: async (ids) => sources.filter((source) => ids.includes(source.sourceId)) },
    starter: { start },
    registry: parts.registry,
    targets: {
      queues: { activities: "pipeline", plan: "plan", label: "label", browser: "browser" },
      channels: { dtc: { resources: { queue: "resource", activities: {}, maxWaitSeconds: 900 } } },
    },
  });
  const store: DispatchStore = {
    controls: async () => [{ channel: "dtc", mode: "running", readyLimit: 2, runningLimit: 2 }],
    running: async () => [],
    fillReady: vi.fn(),
    claim: async () =>
      sources.map((source, index) => ({
        itemId: `item-${index}`,
        channel: "dtc",
        runId: runIds[index] ?? "",
        sourceId: source.sourceId,
        url,
        stopRequested: false,
      })),
    settle: vi.fn(),
    markStopRequested: vi.fn(),
    pauseIfIdle: vi.fn(),
  };
  const dispatcher = new QueueDispatcher(
    {
      store,
      starter: runs,
      log,
      executions: { execution: vi.fn() },
      canceller: { cancel: vi.fn() },
      isPaused: async () => false,
    },
    { intervalMs: 500 },
  );
  await dispatcher.tick(new AbortController().signal);
  expect(store.settle).not.toHaveBeenCalled();
  expect(start).toHaveBeenCalledTimes(catalogs.length);
  return start.mock.calls.map(([, input]) => input);
}

async function capture(parts: WorkerParts, input: ProductPipelineInput) {
  const result = BrowserCaptureResultSchema.parse(
    await browserActivities(parts).captureBrowserProduct?.(input),
  );
  if (result.status !== "captured" || !result.planned) {
    throw new Error("Expected a planned browser capture");
  }
  return result.planned.sourcePlan;
}

async function retained(publication: RetainedPublication, key: string) {
  const bytes = await publication.remote.read(key, 1_000_000, new AbortController().signal);
  return JSON.parse(Buffer.from(bytes ?? []).toString());
}

afterEach(() => vi.restoreAllMocks());

it("captures and plans queued products concurrently with their own database source and brand", async () => {
  const test = setup();
  const inputs = await queuedInputs(test.parts);
  const bind = vi.spyOn(test.parts.channelPlans, "forBrandSource");
  await Promise.all(
    inputs.map(async (input, index) => {
      expect(input.sourceId).toBe(sourceIds[index]);
      expect(input.sourceUrl).toBe(index === 0 ? alphaUrl : betaUrl);
      const sourcePlan = await capture(test.parts, input);
      expect(sourcePlan.owner.sourceId).toBe(input.sourceId);
      const projection = await retained(test.publication, sourcePlan.source.objectKey);
      expect(projection.brandEvidence).toMatchObject({
        source: { brand: index === 0 ? "Alpha" : "Beta", catalogUrl: input.sourceUrl },
        observedBrand: "Beta",
        status: index === 0 ? "mismatch" : "matched",
      });
      expect(
        await pipelineActivities(test.parts).prepareChannelProduct?.({
          ...sourcePlan,
          sourceUrl: input.sourceUrl,
        }),
      ).toMatchObject({ status: "prepared" });
      const plan = ChannelProductPlanSchema.parse(
        await retained(test.publication, planKey(sourcePlan)),
      );
      expect(plan.input.owner.sourceId).toBe(input.sourceId);
      expect(plan.product.brandRaw).toBe("Beta");
      expect(plan.product.warnings.includes("DTC.BRAND_MISMATCH")).toBe(index === 0);
    }),
  );
  expect(bind.mock.calls).toEqual(
    expect.arrayContaining([
      ["dtc", alphaUrl],
      ["dtc", betaUrl],
    ]),
  );
  expect(test.read).toHaveBeenCalledTimes(2);
  expect(test.records.size).toBe(0);
});

it("refuses planning a capture under another brand's catalog", async () => {
  const test = setup();
  const [input] = await queuedInputs(test.parts, [alphaUrl]);
  if (!input) {
    throw new Error("Expected queued input");
  }
  const sourcePlan = await capture(test.parts, input);
  expect(
    await pipelineActivities(test.parts).prepareChannelProduct?.({
      ...sourcePlan,
      sourceUrl: betaUrl,
    }),
  ).toMatchObject({ status: "review", code: "DTC.IDENTITY_CONFLICT" });
  expect(test.read).toHaveBeenCalledOnce();
  expect(test.records.size).toBe(1);
});

it("keeps single-brand evidence and legacy activity inputs unchanged", async () => {
  const test = setup(true);
  const [input] = await queuedInputs(test.parts, [alphaUrl]);
  if (!input) {
    throw new Error("Expected queued input");
  }
  const sourcePlan = await capture(test.parts, input);
  const projection = await retained(test.publication, sourcePlan.source.objectKey);
  expect(projection.codec).toBe("channel-product/1");
  expect(projection.brandRaw).toBe("shop.example");
  const { sourceUrl: _sourceUrl, ...legacy } = input;
  const legacyPlan = await capture(test.parts, legacy);
  expect(legacyPlan).toEqual(sourcePlan);
  expect(await pipelineActivities(test.parts).prepareChannelProduct?.(sourcePlan)).toMatchObject({
    status: "prepared",
  });
  expect(test.read).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "scans only the requested brand collection (foreign next: %s)",
  async (foreignNext) => {
    const test = setup();
    const next = foreignNext ? betaUrl : `${alphaUrl}?page=2`;
    const listing = (handle: string) =>
      `<main><div id="product-grid"><a href="/products/${handle}">${handle}</a></div></main>`;
    test.read
      .mockResolvedValueOnce({
        url: alphaUrl,
        html: listing("sleep") + `<a rel="next" href="${next}">Next</a>`,
        status: 200,
        ready: true,
        scroll: { rounds: 2, ended: "stable" },
      })
      .mockResolvedValueOnce({
        url: next,
        html: listing("rest"),
        status: 200,
        ready: true,
        scroll: { rounds: 2, ended: "stable" },
      });
    const request = {
      channel: "dtc",
      capture: "browser",
      scanId: "alpha-scan",
      sourceId: sourceIds[0],
      sourceUrl: alphaUrl,
    };
    const scan = vi.spyOn(test.parts.browser.scanner, "scan");
    const result = browserActivities(test.parts).scanBrandInBrowser?.(request);
    if (foreignNext) {
      await expect(result).rejects.toMatchObject({ type: "CHANNEL.URL_REJECTED" });
      expect(test.read).toHaveBeenCalledTimes(1);
    } else {
      await expect(result).resolves.toMatchObject({
        complete: true,
        source: { brand: "Alpha", catalogUrl: alphaUrl },
        pages: [
          { products: [expect.objectContaining({ url, brand: "Alpha" })] },
          {
            products: [expect.objectContaining({ url: `${origin}/products/rest`, brand: "Alpha" })],
          },
        ],
      });
      expect(test.read.mock.calls.map(([input]) => input.url)).toEqual([alphaUrl, next]);
    }
    expect(scan).toHaveBeenCalledWith(
      { scanId: request.scanId, sourceId: request.sourceId, sourceUrl: alphaUrl },
      expect.any(AbortSignal),
    );
  },
);
