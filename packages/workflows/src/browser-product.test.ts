import { beforeEach, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ activities: {} as Record<string, unknown> }));

vi.mock("@temporalio/workflow", () => {
  class ApplicationFailure extends Error {
    constructor(
      message: string,
      readonly type: string,
    ) {
      super(message);
    }
    static nonRetryable(message: string, type: string) {
      return new ApplicationFailure(message, type);
    }
  }
  return {
    defineSignal: (name: string) => name,
    proxyActivities: ({ taskQueue }: { taskQueue: string }) => env.activities[taskQueue],
    workflowInfo: () => ({ workflowId: "product-run-1", runId: "run-1" }),
    // Historical browser product results retain their recorded route before capture-mode-v1.
    patched: (marker: string) =>
      !["capture-mode-v1", "family-formula-outcomes-v1", "product-enrichment-v1"].includes(marker),
    sleep: async () => undefined,
    isCancellation: (error: unknown) => (error as { type?: string }).type === "CANCELLED",
    CancellationScope: { nonCancellable: (run: () => unknown) => run() },
    ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
    ActivityFailure: class extends Error {},
    ApplicationFailure,
  };
});

import { ProductPipelineWorkflow } from "./product-pipeline-workflow.js";

const input = {
  codec: "product-pipeline/1",
  runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  channel: "wholefoods",
  url: "https://www.wholefoodsmarket.com/grocery/product/nordic-naturals-omega-B002CQU54Q",
  brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  operationId: "pipeline-capture-1",
  queues: { activities: "pipeline", plan: "plan", label: "label", browser: "browser" },
  resources: { queue: "resource", activities: {} },
};

const pendingFormula = {
  status: "collected",
  reusedFormula: false,
  formulaPending: true,
  listingId: "B002CQU54Q",
};

function setup() {
  const browser = {
    captureBrowserProduct: vi.fn(async (): Promise<unknown> => ({
      status: "captured",
      listingId: "B002CQU54Q",
      variantId: null,
      archiveKey: "v3/wholefoods-html/pipeline-capture-1/original.html",
    })),
  };
  const pipeline = {
    findKnownFormula: vi.fn(async (): Promise<unknown> => ({ operationId: "amazon-formula-1" })),
    reviewProduct: vi.fn(async () => ({ status: "review", code: "TEST.REVIEW" })),
    requestAmazonFormula: vi.fn(async (): Promise<unknown> => ({ status: "queued" })),
  };
  const plan = { prepareChannelProduct: vi.fn() };
  env.activities = { browser, pipeline, plan };
  return { browser, pipeline, plan };
}

beforeEach(() => vi.clearAllMocks());

it("replays a legacy Whole Foods browser capture and takes the formula of the same ASIN from its family", async () => {
  const { browser, pipeline, plan } = setup();

  expect(await ProductPipelineWorkflow(input)).toEqual({
    status: "collected",
    reusedFormula: true,
    operationId: "amazon-formula-1",
    listingId: "B002CQU54Q",
  });

  expect(browser.captureBrowserProduct).toHaveBeenCalledOnce();
  expect(pipeline.findKnownFormula).toHaveBeenCalledWith(
    expect.objectContaining({ channel: "wholefoods", listingId: "B002CQU54Q" }),
  );
  expect(plan.prepareChannelProduct).not.toHaveBeenCalled();
  expect(pipeline.requestAmazonFormula).not.toHaveBeenCalled();
});

it("an ASIN with no formula yet is queued for Amazon and completes as formula pending, with no label reading and no Review", async () => {
  const { pipeline } = setup();
  pipeline.findKnownFormula.mockResolvedValue(null);

  expect(await ProductPipelineWorkflow(input)).toEqual(pendingFormula);

  expect(pipeline.requestAmazonFormula).toHaveBeenCalledWith({
    brandId: input.brandId,
    listingId: "B002CQU54Q",
  });
  expect(pipeline.reviewProduct).not.toHaveBeenCalled();
});

it("without a browser task queue the product is a Review, and nothing is fetched", async () => {
  const { browser, pipeline } = setup();
  const { browser: _browser, ...queues } = input.queues;

  await ProductPipelineWorkflow({ ...input, queues });

  expect(browser.captureBrowserProduct).not.toHaveBeenCalled();
  expect(pipeline.reviewProduct).toHaveBeenCalledWith(
    expect.objectContaining({ causeCode: "PIPELINE.BROWSER_QUEUE_MISSING" }),
  );
});
