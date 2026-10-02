import { beforeEach, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  activities: {} as Record<string, unknown>,
  start: vi.fn(),
  patched: vi.fn((_marker: string) => true),
  held: false,
}));

vi.mock("@temporalio/workflow", () => ({
  defineSignal: (name: string) => name,
  proxyActivities: ({ taskQueue }: { taskQueue: string }) => env.activities[taskQueue],
  patched: env.patched,
  startChild: env.start,
  workflowInfo: () => ({ workflowId: "dtc-run" }),
  isCancellation: () => false,
  CancellationScope: { nonCancellable: (run: () => unknown) => run() },
  ParentClosePolicy: { REQUEST_CANCEL: "REQUEST_CANCEL" },
  WorkflowIdReusePolicy: { REJECT_DUPLICATE: "REJECT_DUPLICATE" },
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
  ApplicationFailure: { nonRetryable: (message: string) => new Error(message) },
}));
vi.mock("./resources/versioned-gate.js", () => ({
  versionedResourceGate:
    () => async (_name: string, run: (binding: object) => Promise<unknown>) => {
      env.held = true;
      try {
        return await run({});
      } finally {
        env.held = false;
      }
    },
}));

import { ChannelPlanInputSchema } from "@crawl-automation/v3-contracts";
import { ProductPipelineWorkflow } from "./product-pipeline-workflow.js";
import { pipelineFixture } from "./testing/replay/product-fixture.js";

async function setup() {
  const fixture = pipelineFixture("pipeline");
  const captured = await fixture.activities.captureProduct();
  const sourcePlan = ChannelPlanInputSchema.parse({
    ...captured.sourcePlan,
    channel: "dtc",
    parserVersion: "dtc-rendered/1",
    expectedUrl: "https://shop.example/products/sleep?variant=11",
    owner: { ...captured.sourcePlan.owner, variantId: "11", sourceId: fixture.input.sourceId },
    source: {
      ...captured.sourcePlan.source,
      sourceId: fixture.input.sourceId,
      variantId: "11",
      producer: {
        ...captured.sourcePlan.source.producer,
        module: "dtc.browser-projection",
        implementationVersion: "dtc-rendered/1",
      },
    },
  });
  const planned = { ...captured, sourcePlan, family: null };
  const pipeline = {
    ...fixture.activities,
    captureProduct: vi.fn(),
    requestAmazonFormula: vi.fn(),
    findKnownFormula: vi.fn(async () => null),
    prepareChannelProduct: vi.fn(async () => {
      expect(env.held).toBe(false);
      return fixture.activities.prepareChannelProduct();
    }),
    prepareLabelTask: vi.fn(fixture.activities.prepareLabelTask),
    reviewProduct: vi.fn(async () => ({ status: "review" })),
  };
  const browser = {
    captureBrowserProduct: vi.fn(async () => ({
      status: "captured",
      listingId: sourcePlan.owner.listingId,
      variantId: "11",
      archiveKey: "retained/dtc.html",
      planned,
    })),
  };
  env.activities = { pipeline, "v3.browser.server2-ego-space-6": browser };
  env.start.mockResolvedValue({ signal: vi.fn(), result: async () => ({ status: "collected" }) });
  const input = {
    ...fixture.input,
    channel: "dtc",
    capture: "browser",
    url: sourcePlan.expectedUrl,
    queues: { ...fixture.input.queues, browser: "v3.browser.server2-ego-space-6" },
  };
  return { pipeline, browser, input, sourcePlan };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Capture-routing histories before enrichment keep their original child/result sequence.
  env.patched.mockImplementation((marker: string) => marker !== "product-enrichment-v1");
});

it("sends a DTC browser capture through planning and the normal Label workflow", async () => {
  const test = await setup();
  expect(await ProductPipelineWorkflow(test.input)).toEqual({ status: "collected" });
  expect(test.browser.captureBrowserProduct).toHaveBeenCalledOnce();
  expect(test.pipeline.captureProduct).not.toHaveBeenCalled();
  expect(test.pipeline.prepareChannelProduct).toHaveBeenCalledExactlyOnceWith(test.sourcePlan);
  expect(test.pipeline.prepareLabelTask).toHaveBeenCalledWith({
    pipeline: test.input,
    sourcePlan: test.sourcePlan,
  });
  expect(env.start).toHaveBeenCalledWith("LabelWorkflow", expect.anything());
  expect(env.patched).toHaveBeenCalledWith("browser-formula-plan-v1");
  expect(test.pipeline.requestAmazonFormula).not.toHaveBeenCalled();
});

it("keeps the recorded browser command sequence when the formula-plan marker is absent", async () => {
  const test = await setup();
  env.patched.mockImplementation((...args: unknown[]) => args[0] !== "browser-formula-plan-v1");
  await ProductPipelineWorkflow(test.input);
  expect(test.pipeline.prepareChannelProduct).not.toHaveBeenCalled();
  expect(test.pipeline.requestAmazonFormula).toHaveBeenCalledOnce();
  expect(env.start).not.toHaveBeenCalled();
});

it("carries the source ID and catalog to browser capture and formula planning", async () => {
  const test = await setup();
  const input = { ...test.input, sourceUrl: "https://shop.example/collections/alpha" };
  await ProductPipelineWorkflow(input);
  expect(test.browser.captureBrowserProduct).toHaveBeenCalledExactlyOnceWith(input);
  expect(test.pipeline.prepareChannelProduct).toHaveBeenCalledExactlyOnceWith({
    ...test.sourcePlan,
    sourceUrl: input.sourceUrl,
  });
  expect(test.sourcePlan.owner.sourceId).toBe(input.sourceId);
});
