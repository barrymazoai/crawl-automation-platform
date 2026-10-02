import { beforeEach, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  activities: {} as Record<string, unknown>,
  start: vi.fn(),
  execute: vi.fn(),
  patched: vi.fn((_marker: string) => true),
  held: false,
}));

vi.mock("@temporalio/workflow", () => ({
  defineSignal: (name: string) => name,
  proxyActivities: ({ taskQueue }: { taskQueue: string }) => env.activities[taskQueue],
  patched: env.patched,
  startChild: env.start,
  executeChild: env.execute,
  workflowInfo: () => ({ workflowId: "dtc-run" }),
  isCancellation: (error: unknown) => error === "cancelled",
  CancellationScope: { nonCancellable: (run: () => unknown) => run() },
  ParentClosePolicy: { REQUEST_CANCEL: "REQUEST_CANCEL" },
  ChildWorkflowCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
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
import { DtcVariantWorkflow } from "./dtc-variants.js";
import type { DtcVariantHandoff } from "@crawl-automation/v3-contracts";

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
  const planned = { ...captured, status: "captured" as const, sourcePlan, family: null };
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
  return { pipeline, browser, input, sourcePlan, planned };
}

beforeEach(() => {
  vi.clearAllMocks();
  env.execute.mockReset();
  // Capture-routing histories before enrichment keep their original child/result sequence.
  env.patched.mockImplementation((marker: string) => marker !== "product-enrichment-v1");
});

async function variantSetup() {
  const test = await setup();
  const variants: DtcVariantHandoff[] = ["11", "22"].map((variantId) => ({
    status: "ready",
    operationId: `variant-${variantId}`,
    evidence: ["observed.html"],
    variant: {
      listingId: test.sourcePlan.owner.listingId,
      variantId,
      url: `https://shop.example/products/sleep?variant=${variantId}`,
      title: variantId,
      available: variantId !== "11",
    },
    planned: {
      ...test.planned,
      sourcePlan: {
        ...test.sourcePlan,
        expectedUrl: `https://shop.example/products/sleep?variant=${variantId}`,
        owner: { ...test.sourcePlan.owner, variantId },
        source: { ...test.sourcePlan.source, variantId },
      },
    },
  }));
  const capture = await test.browser.captureBrowserProduct();
  test.browser.captureBrowserProduct.mockResolvedValue({ ...capture, variants } as typeof capture);
  test.browser.captureBrowserProduct.mockClear();
  env.execute.mockImplementation(async (_name, _options) => {
    expect(env.held).toBe(false);
    return { status: "collected", operationId: "formula", enrichment: { status: "registered" } };
  });
  env.patched.mockReturnValue(true);
  return { ...test, variants };
}

it("captures once, releases the browser, and processes every website variant with independent children", async () => {
  const test = await variantSetup();
  const result = await ProductPipelineWorkflow(test.input);
  expect(result).toMatchObject({
    status: "collected",
    counts: { total: 2, completed: 2, review: 0 },
  });
  expect(test.browser.captureBrowserProduct).toHaveBeenCalledOnce();
  expect(test.pipeline.prepareChannelProduct).not.toHaveBeenCalled();
  expect(env.execute.mock.calls.map(([name, options]) => [name, options.workflowId])).toEqual([
    ["DtcVariantWorkflow", "dtc-run-variant-11"],
    ["DtcVariantWorkflow", "dtc-run-variant-22"],
  ]);
  expect(env.execute.mock.calls[0]?.[1]).toMatchObject({
    retry: { maximumAttempts: 1 },
    cancellationType: "WAIT",
    args: [{ input: { operationId: "variant-11", url: test.variants[0]?.variant.url } }],
  });
});

it.each(["missing-evidence", "child-failed", "enrichment-pending", "review-write-failed"])(
  "keeps sibling results and truthful counts after %s",
  async (failure) => {
    const test = await variantSetup();
    if (failure === "child-failed" || failure === "review-write-failed") {
      env.execute.mockRejectedValueOnce(new Error("child failed"));
    } else if (failure === "enrichment-pending") {
      env.execute.mockResolvedValueOnce({ status: "collected", enrichment: { status: "pending" } });
    } else {
      const first = test.variants[0];
      if (!first) {
        throw new Error("fixture");
      }
      test.variants[0] = {
        status: "review",
        operationId: first.operationId,
        variant: first.variant,
        evidence: first.evidence,
        code: "DTC.VARIANT_EVIDENCE",
        reason: "Scope unresolved",
      };
    }
    if (failure === "review-write-failed") {
      test.pipeline.reviewProduct.mockRejectedValueOnce(new Error("review store failed"));
    }
    const result = await ProductPipelineWorkflow(test.input);
    expect(result).toMatchObject({
      status: "review",
      code: "DTC.VARIANTS_INCOMPLETE",
      counts: { total: 2, completed: 1, review: 1 },
      variants: [
        { variant: { variantId: "11" } },
        { variant: { variantId: "22" }, result: { status: "collected" } },
      ],
    });
  },
);

it("propagates cancellation instead of starting the remaining variant", async () => {
  const test = await variantSetup();
  env.execute.mockRejectedValueOnce("cancelled");
  await expect(ProductPipelineWorkflow(test.input)).rejects.toBe("cancelled");
  expect(env.execute).toHaveBeenCalledOnce();
  expect(test.pipeline.reviewProduct).not.toHaveBeenCalled();
});

it("retains the original base plan sequence without the new patch marker", async () => {
  const test = await variantSetup();
  env.patched.mockImplementation(
    (marker) => !["dtc-variant-handoff-v1", "product-enrichment-v1"].includes(marker),
  );
  await ProductPipelineWorkflow(test.input);
  expect(env.execute).not.toHaveBeenCalled();
  expect(test.pipeline.prepareChannelProduct).toHaveBeenCalledOnce();
});

it("runs the existing Label and enrichment pipeline inside the variant without recapture", async () => {
  const test = await variantSetup();
  const member = test.variants[0];
  if (!member || member.status !== "ready") {
    throw new Error("fixture");
  }
  env.start.mockResolvedValue({
    signal: vi.fn(),
    result: async () => ({
      status: "collected",
      operationId: "label-variant",
      observation: member.planned.sourcePlan.owner,
    }),
  });
  env.execute.mockResolvedValue({ status: "registered" });
  const input = {
    ...test.input,
    channel: "dtc",
    operationId: member.operationId,
    url: member.variant.url,
  };
  expect(await DtcVariantWorkflow({ input, member })).toMatchObject({
    status: "collected",
    enrichment: { status: "registered" },
  });
  expect(test.pipeline.prepareChannelProduct).toHaveBeenCalledWith(member.planned.sourcePlan);
  expect(test.pipeline.prepareLabelTask).toHaveBeenCalledWith({
    pipeline: input,
    sourcePlan: member.planned.sourcePlan,
  });
  expect(env.execute).toHaveBeenCalledWith(
    "ProductEnrichmentWorkflow",
    expect.objectContaining({
      args: [
        expect.objectContaining({
          request: expect.objectContaining({
            captureOperationId: member.operationId,
            variantId: "11",
          }),
        }),
      ],
    }),
  );
  expect(test.browser.captureBrowserProduct).not.toHaveBeenCalled();
  expect(test.pipeline.captureProduct).not.toHaveBeenCalled();
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
