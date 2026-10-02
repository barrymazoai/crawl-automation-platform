import { PostgresBrandScans, PostgresResourceStore } from "@crawl-automation/adapters";
import { configurePermitActivityLedger } from "@crawl-automation/app";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import {
  createDtcAdapter,
  configuredDtcSites,
  DtcSettingsSchema,
} from "@crawl-automation/channel-dtc";
import { createLogger } from "@crawl-automation/platform";
import { browserTaskQueue, LEGACY_BROWSER_QUEUE } from "@crawl-automation/platform/browser-routing";
import type { BrowserResourceId } from "@crawl-automation/platform/browser-routing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkerParts } from "../container.js";
import { browserActivities } from "./browser-activities.js";
import { brandListingActivities } from "./brand-listing-activities.js";
import { ProductPipelineInputSchema } from "@crawl-automation/workflows";

const context = vi.hoisted(() => ({
  info: {
    activityId: "permit-browser",
    attempt: 1,
    taskQueue: "",
    workflowExecution: {
      workflowId: "browser-test",
      runId: "11111111-1111-4111-8111-111111111111",
    },
  },
  heartbeat: vi.fn(),
  cancellationSignal: new AbortController().signal,
}));
vi.mock("@temporalio/activity", () => ({ Context: { current: () => context } }));

const hosts = ["mini-ego-space-1", "server2-ego-space-6"] as const;
const scanId = "22222222-2222-4222-8222-222222222222";
const source = { sourceId: scanId, channel: "dtc", url: "https://shop.example/collections/all" };
const ledger = {
  begin: vi.fn(async () => false),
  finish: vi.fn(),
  record: vi.fn(),
  prove: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  configurePermitActivityLedger(ledger);
  vi.spyOn(PostgresBrandScans.prototype, "isCancellationRequested").mockResolvedValue(false);
});
afterEach(() => vi.restoreAllMocks());

function fixture(resourceId: BrowserResourceId) {
  context.info.taskQueue = browserTaskQueue(resourceId);
  const scan = vi.fn(async () => ({ pages: [], complete: true, soldHere: true }));
  const capture = vi.fn(async () => ({ status: "captured" }));
  const ensureStore = vi.fn(async () => undefined);
  const parts = {
    config: { browser: { resourceId, pollLegacyQueue: resourceId === hosts[0] } },
    registry: new ChannelRegistry([
      createDtcAdapter(
        configuredDtcSites(
          DtcSettingsSchema.parse({
            sites: [{ siteKey: "shop.example", platform: "jsonld", catalogUrl: source.url }],
          }),
        ),
      ),
    ]),
    browser: { scanner: { scan }, capture: { capture }, ensureStore },
    log: createLogger({ name: "routing-test", level: "fatal" }),
    database: {},
  } as unknown as WorkerParts;
  return { parts, scan, capture, ensureStore };
}

function hold(resourceId: string) {
  return vi.spyOn(PostgresResourceStore.prototype, "findHeld").mockResolvedValue({
    ...context.info.workflowExecution,
    permitId: context.info.activityId,
    resources: [resourceId],
    grantedAt: "now",
  });
}

function activities(parts: WorkerParts): Record<string, (raw: unknown) => Promise<unknown>> {
  return { ...browserActivities(parts), ...brandListingActivities(parts) };
}

it.each(hosts)(
  "%s refuses every browser entry point for the other host before beginning execution",
  async (host) => {
    const test = fixture(host);
    hold(host === hosts[0] ? hosts[1] : hosts[0]);
    for (const [name, activity] of Object.entries(activities(test.parts))) {
      const raw = name === "readBrandListing" ? { scanId, source } : {};
      await expect(activity(raw)).rejects.toMatchObject({
        type: "RESOURCE.BROWSER_PERMIT_MISMATCH",
        nonRetryable: true,
      });
    }
    expect(ledger.begin).not.toHaveBeenCalled();
    expect(ledger.finish).not.toHaveBeenCalled();
    expect(test.ensureStore).not.toHaveBeenCalled();
    expect(test.scan).not.toHaveBeenCalled();
    expect(test.capture).not.toHaveBeenCalled();
  },
);

it.each(hosts)("%s executes scans and products only with its own held permit", async (host) => {
  const test = fixture(host);
  hold(host);
  const work = activities(test.parts);
  await work.scanBrandInBrowser?.({ channel: "dtc", scanId, sourceUrl: source.url });
  await work.readBrandListing?.({ scanId, source });
  await work.captureBrowserProduct?.(
    ProductPipelineInputSchema.parse({
      codec: "product-pipeline/1",
      runId: scanId,
      brandId: scanId,
      sourceId: scanId,
      channel: "dtc",
      capture: "browser",
      url: "https://shop.example/products/one",
      operationId: "test-capture",
      queues: { activities: "pipeline", plan: "plan", label: "label" },
      resources: { queue: "resources", activities: {} },
    }),
  );
  expect(test.scan).toHaveBeenCalledTimes(2);
  expect(test.capture).toHaveBeenCalledOnce();
  expect(ledger.begin).toHaveBeenCalledTimes(3);
});

it.each(hosts)(
  "legacy queue work still requires the Server 一 permit (held by %s)",
  async (host) => {
    const test = fixture(hosts[0]);
    hold(host);
    context.info.taskQueue = LEGACY_BROWSER_QUEUE;
    const pending = activities(test.parts).scanBrandInBrowser?.({
      channel: "dtc",
      scanId,
      sourceUrl: source.url,
    });
    if (host === hosts[0]) {
      await expect(pending).resolves.toBeDefined();
      expect(test.scan).toHaveBeenCalledOnce();
    } else {
      await expect(pending).rejects.toMatchObject({ type: "RESOURCE.BROWSER_PERMIT_MISMATCH" });
      expect(test.scan).not.toHaveBeenCalled();
    }
  },
);

it.each([LEGACY_BROWSER_QUEUE, "v3.browser.mini-ego-space-1", "pipeline"])(
  "Server 二 refuses browser work arriving on %s even with its own permit",
  async (taskQueue) => {
    const test = fixture(hosts[1]);
    const read = hold(hosts[1]);
    context.info.taskQueue = taskQueue;
    await expect(activities(test.parts).scanBrandInBrowser?.({})).rejects.toMatchObject({
      type: "RESOURCE.BROWSER_PERMIT_MISMATCH",
      nonRetryable: true,
    });
    expect(read).not.toHaveBeenCalled();
    expect(ledger.begin).not.toHaveBeenCalled();
  },
);
