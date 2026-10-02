import { beforeEach, expect, it, vi } from "vitest";
import { browserTaskQueue, LEGACY_BROWSER_QUEUE } from "@crawl-automation/platform/browser-routing";
import type { ResourceRequest } from "@crawl-automation/v3-contracts";
import { ProductPipelineInputSchema, type PipelineActivities } from "./pipeline-model.js";
import { captureReview, productInput } from "./resources/testing/gate-fixture.js";

const state = vi.hoisted(() => ({
  enabled: true,
  queue: "v3.browser.wholefoods.v1",
  needs: [] as ResourceRequest["needs"],
  options: [] as Array<Record<string, unknown>>,
  reserve: vi.fn(),
  release: vi.fn(),
  work: vi.fn(),
}));
vi.mock("@temporalio/workflow", async () => ({
  log: { info: vi.fn() },
  ApplicationFailure: (
    await vi.importActual<typeof import("@temporalio/common")>("@temporalio/common")
  ).ApplicationFailure,
  patched: (marker: string) => marker !== "browser-resource-routing-v1" || state.enabled,
  proxyActivities: (options: Record<string, unknown>) => {
    state.options.push(options);
    return {
      reserveResources: state.reserve,
      releaseResources: state.release,
      scanBrandInBrowser: state.work,
      readBrandListing: state.work,
      captureBrowserProduct: state.work,
    };
  },
  workflowInfo: () => ({
    taskQueue: state.queue,
    workflowId: "test",
    runId: "11111111-1111-4111-8111-111111111111",
  }),
  CancellationScope: {
    nonCancellable: (run: () => unknown) => run(),
    current: () => ({ consideredCancelled: false }),
  },
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
  defineSignal: (name: string) => name,
  isCancellation: () => false,
}));

import { BrowserScanWorkflow } from "./browser-scan-workflow.js";
import { BrandListingWorkflow } from "./collection/brand-listing-workflow.js";
import { collectInBrowser } from "./browser-product.js";
import { browserRoute } from "./resources/browser-route.js";

const hosts = ["mini-ego-space-1", "server2-ego-space-6"] as const;
beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = true;
  state.queue = LEGACY_BROWSER_QUEUE;
  state.options = [];
  state.needs = [];
  state.work.mockResolvedValue(captureReview());
  state.reserve.mockImplementation(async (request: ResourceRequest) => {
    state.needs = request.needs;
    return { permitId: request.permitId, status: "granted", reason: "available" };
  });
  state.release.mockImplementation(async (request: ResourceRequest) => ({
    permitId: request.permitId,
    status: "released",
    reason: "released",
  }));
});

function gate(activity: string, resourceId: string) {
  return {
    queue: "resources",
    maxWaitSeconds: 900,
    activities: { [activity]: [{ resourceId, units: 1 }] },
  };
}

it.each(hosts)(
  "routes DTC products to the held %s permit despite a different input queue",
  async (resourceId) => {
    const resources = gate("captureProduct", resourceId);
    const input = ProductPipelineInputSchema.parse({
      ...productInput("pipeline", "dtc"),
      resources,
    });
    await collectInBrowser(input, {} as PipelineActivities);
    expect(state.work).toHaveBeenCalledExactlyOnceWith(input);
    expect(
      state.options.find((options) => options.taskQueue === browserTaskQueue(resourceId)),
    ).toMatchObject({
      retry: { maximumAttempts: 1 },
      activityId: expect.stringContaining("permit-"),
    });
    expect(state.needs).toEqual(resources.activities.captureProduct);
    expect(state.release).toHaveBeenCalledOnce();
  },
);

it.each(
  hosts.flatMap((host) => ["wholefoods", "costco", "dtc"].map((channel) => ({ host, channel }))),
)(
  "takes $host as well as the $channel scan pacing permit before dispatch",
  async ({ host, channel }) => {
    state.queue = browserTaskQueue(host);
    await BrowserScanWorkflow({
      channel,
      scanId: "scan",
      sourceUrl: "https://example.com/brand",
      resources: gate("scanBrandInBrowser", `${channel}-brand-scan`),
    });
    expect(state.needs).toEqual([
      { resourceId: `${channel}-brand-scan`, units: 1 },
      { resourceId: host, units: 1 },
    ]);
    expect(state.options.at(-1)).toMatchObject({ taskQueue: browserTaskQueue(host) });
    expect(state.work).toHaveBeenCalledOnce();
    expect(state.release).toHaveBeenCalledOnce();
  },
);

it.each(hosts)("routes a DTC BrandListingWorkflow by its %s permit", async (resourceId) => {
  await BrandListingWorkflow({
    scanId: "22222222-2222-4222-8222-222222222222",
    source: {
      sourceId: "33333333-3333-4333-8333-333333333333",
      channel: "dtc",
      url: "https://example.com/brand",
    },
    resources: gate("readBrandListing", resourceId),
  });
  expect(state.options.at(-1)).toMatchObject({ taskQueue: browserTaskQueue(resourceId) });
  expect(state.needs).toEqual([{ resourceId, units: 1 }]);
});

it("leaves HTTP listing queues and permits unchanged", () => {
  const input = {
    resources: gate("readBrandListing", "swanson-brand-scan"),
    activity: "readBrandListing",
    queue: "pipeline",
    required: false,
  };
  expect(browserRoute(input)).toBe(input);
});

it("fails closed without a host or resource gate before any business activity", async () => {
  for (const resources of [
    undefined,
    gate("scanBrandInBrowser", "wholefoods-brand-scan"),
    {
      queue: "resources",
      activities: { scanBrandInBrowser: hosts.map((resourceId) => ({ resourceId, units: 1 })) },
    },
  ]) {
    await expect(
      BrowserScanWorkflow({
        channel: "wholefoods",
        scanId: "scan",
        sourceUrl: "https://example.com",
        resources,
      }),
    ).rejects.toMatchObject({
      type: "RESOURCE.BROWSER_ROUTE_INVALID",
      nonRetryable: true,
    });
  }
  expect(state.reserve).not.toHaveBeenCalled();
  expect(state.work).not.toHaveBeenCalled();
});

it("retains the old shared queue and exact needs when the marker is absent", async () => {
  state.enabled = false;
  const resources = gate("scanBrandInBrowser", hosts[1]);
  await BrowserScanWorkflow({
    channel: "dtc",
    scanId: "scan",
    sourceUrl: "https://example.com",
    resources,
  });
  expect(state.options.at(-1)).toMatchObject({ taskQueue: LEGACY_BROWSER_QUEUE });
  expect(state.needs).toEqual(resources.activities.scanBrandInBrowser);
});
