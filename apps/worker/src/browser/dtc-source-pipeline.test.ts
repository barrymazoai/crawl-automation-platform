import {
  PostgresBrandScans,
  PostgresSiteAnalyses,
  PostgresResourceStore,
} from "@crawl-automation/adapters";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  agentSettings,
  cleanupCaptures,
  mockCapture,
  catalogFixture,
} from "./fixtures/dtc-agent.js";
vi.mock("@crawl-automation/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@crawl-automation/platform")>()),
  currentPermitExecution: () => ({ permitId: "permit", workflowId: "product", runId: "execution" }),
}));

// Routing admission is exercised with the real guard in activities/browser-routing.test.ts.
vi.mock("../activities/browser-permit.js", () => ({ checkBrowserPermit: vi.fn() }));

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
  captureRecords: () => ({
    listings: { record: vi.fn(async () => ({ observationId: "listing-observation" })) },
    history: { record: vi.fn() },
  }),
}));

import {
  ProductRuns,
  QueueDispatcher,
  type DispatchStore,
  type ScanSource,
} from "@crawl-automation/app";
import { ProductPlans, planKey } from "@crawl-automation/channels-core";
import {
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

beforeEach(() => {
  vi.spyOn(PostgresResourceStore.prototype, "findHeld").mockResolvedValue({
    resources: ["test-model"],
    workflowId: "product",
    runId: "execution",
  } as Awaited<ReturnType<PostgresResourceStore["findHeld"]>>);
  vi.spyOn(PostgresSiteAnalyses.prototype, "settings").mockResolvedValue([]);
  vi.spyOn(PostgresBrandScans.prototype, "isCancellationRequested").mockResolvedValue(false);
});

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
  image: `${origin}/label.jpg`,
  description: "Serving Size: 2 capsules. Magnesium 100 mg. Other Ingredients: cellulose.",
  offers: { url: `${url}?variant=11`, price: "12.50", priceCurrency: "USD" },
})}</script><form action="/cart/add"><input name="id" value="11"></form></main>`;

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

function setup(single = false, variantCount = 1) {
  const browser = BrowserSettingsSchema.parse({
    resourceId: "mini-ego-space-1",
    dtcAgent: agentSettings,
    ego: { cliPath: "/tmp/not-executed-ego", taskSpaceId: 2 },
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
  const read = mockCapture(publication, { url, html, variantCount });
  return { parts, read, publication, records };
}

async function queuedInputs(parts: WorkerParts, catalogs = [alphaUrl, betaUrl]) {
  const sources: ScanSource[] = catalogs.map((catalog, index) => ({
    sourceId: sourceIds[index] ?? "",
    brandId,
    channel: "dtc",
    url: catalog,
    brandName: catalog === alphaUrl ? "Alpha" : "Beta",
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

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupCaptures();
});

it("rejects the cross-brand task and plans only the matching brand task", async () => {
  const test = setup();
  const inputs = await queuedInputs(test.parts);
  const bind = vi.spyOn(test.parts.channelPlans, "forBrandSource");
  await Promise.all(
    inputs.map(async (input, index) => {
      expect(input.sourceId).toBe(sourceIds[index]);
      expect(input.sourceUrl).toBe(index === 0 ? alphaUrl : betaUrl);
      if (index === 0) {
        expect(await browserActivities(test.parts).captureBrowserProduct?.(input)).toMatchObject({
          status: "listing",
          state: "unlisted",
          reason: "identity_conflict",
          causeCode: "DTC.BRAND_MISMATCH",
        });
        return;
      }
      const sourcePlan = await capture(test.parts, input);
      expect(sourcePlan.owner.sourceId).toBe(input.sourceId);
      const projection = await retained(test.publication, sourcePlan.source.objectKey);
      expect(projection.brandEvidence).toMatchObject({
        source: { brand: index === 0 ? "Alpha" : "Beta", catalogUrl: input.sourceUrl },
        observedBrand: "Beta",
        status: "matched",
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
      expect(plan.input.owner.variantId).toBe("11");
      expect(plan.product.imageCandidates).toEqual([
        expect.objectContaining({ url: `${origin}/label.jpg`, variantId: "11" }),
      ]);
      expect(plan.files).toHaveLength(1);
      expect(plan.product.warnings).not.toContain("DTC.BRAND_MISMATCH");
    }),
  );
  expect(bind.mock.calls).toEqual(expect.arrayContaining([["dtc", betaUrl]]));
  expect(test.read).toHaveBeenCalledTimes(2);
  expect(test.records.size).toBe(0);
});

it("refuses planning a capture under another brand's catalog", async () => {
  const test = setup();
  const [input] = await queuedInputs(test.parts, [betaUrl]);
  if (!input) {
    throw new Error("Expected queued input");
  }
  const sourcePlan = await capture(test.parts, input);
  expect(
    await pipelineActivities(test.parts).prepareChannelProduct?.({
      ...sourcePlan,
      sourceUrl: alphaUrl,
    }),
  ).toMatchObject({ status: "review", code: "DTC.IDENTITY_CONFLICT" });
  expect(test.read).toHaveBeenCalledOnce();
  expect(test.records.size).toBe(1);
});

it.each([1, 2])(
  "plans a single-brand capture and legacy input with %i website variants",
  async (variantCount) => {
    const test = setup(true, variantCount);
    const [input] = await queuedInputs(test.parts, [alphaUrl]);
    if (!input) {
      throw new Error("Expected queued input");
    }
    const sourcePlan = await capture(test.parts, input);
    const projection = await retained(test.publication, sourcePlan.source.objectKey);
    expect(projection.codec).toBe("dtc-product/2");
    expect(projection.brandEvidence).toMatchObject({ status: "site-brand", observedBrand: "Beta" });
    expect(sourcePlan.owner.variantId).toBe(variantCount === 1 ? "11" : null);
    expect(projection.evidence.variants).toHaveLength(variantCount);
    const { sourceUrl: _sourceUrl, ...legacy } = input;
    const legacyPlan = await capture(test.parts, { ...legacy, operationId: "legacy-capture" });
    expect(legacyPlan.owner.variantId).toBe(sourcePlan.owner.variantId);
    expect(await pipelineActivities(test.parts).prepareChannelProduct?.(sourcePlan)).toMatchObject({
      status: "prepared",
    });
    expect(test.read).toHaveBeenCalledTimes(2);
  },
);

it.each([false, true])(
  "scans only the requested brand collection (foreign next: %s)",
  async (foreignNext) => {
    const test = setup();
    const next = foreignNext ? betaUrl : `${alphaUrl}?page=2`;
    test.read.mockImplementationOnce((request) =>
      catalogFixture(test.publication, { operationId: request.operationId, next }),
    );
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
      expect(test.read).toHaveBeenCalledOnce();
      expect(test.read.mock.calls[0]?.[0]).toMatchObject({ mode: "catalog", url: alphaUrl });
    }
    expect(scan).toHaveBeenCalledWith(
      {
        scanId: request.scanId,
        sourceId: request.sourceId,
        sourceUrl: alphaUrl,
        checkpoint: expect.any(Function),
      },
      expect.any(AbortSignal),
    );
  },
);
