import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  patch: true,
  collection: {} as unknown,
  child: vi.fn(),
  activities: {} as Record<string, unknown>,
  gate: vi.fn(),
  collect: vi.fn(),
}));
vi.mock("@temporalio/workflow", () => ({
  patched: (marker: string) => (marker === "product-enrichment-v1" ? state.patch : true),
  proxyActivities: () => state.activities,
  executeChild: state.child,
  workflowInfo: () => ({ workflowId: "pipeline-test" }),
  isCancellation: () => false,
  ParentClosePolicy: { REQUEST_CANCEL: "REQUEST_CANCEL" },
  ChildWorkflowCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
}));
vi.mock("./resources/capture-product.js", () => ({
  captureProduct: async () => ({ status: "captured" }),
}));
vi.mock("./stream-label.js", () => ({ streamLabel: vi.fn() }));
vi.mock("./resources/versioned-gate.js", () => ({ versionedResourceGate: () => state.gate }));
vi.mock("./activity-options.js", () => ({
  once: { retry: { maximumAttempts: 1 } },
  withDownloadHeartbeat: (activities: unknown) => activities,
}));
vi.mock("./collect-captured-product.js", async (original) => ({
  ...(await original<object>()),
  collectCapturedProduct: state.collect,
}));

import { ProductPipelineWorkflow, ProductEnrichmentWorkflow } from "./product-pipeline-workflow.js";
import { enrichCollectedResult } from "./collect-captured-product.js";
import { ProductPipelineInputSchema } from "./pipeline-model.js";
import { productInput } from "./resources/testing/gate-fixture.js";

const input = ProductPipelineInputSchema.parse(productInput("enrichment", "gnc"));
const review = { status: "review", reviewId: "enrich-review", code: "ENRICH.OUTPUT_INVALID" };
beforeEach(() => {
  vi.clearAllMocks();
  state.patch = true;
  state.collection = { status: "collected", operationId: "collected-one" };
  state.collect.mockImplementation(async () => state.collection);
  state.child.mockResolvedValue(review);
  state.activities = {
    prepareProductEnrichment: vi.fn(async () => ({
      queue: "model",
      resources: {
        queue: "resources",
        activities: { enrichCollectedProduct: [{ resourceId: "models", units: 1 }] },
      },
    })),
    enrichCollectedProduct: vi.fn(async () => review),
    reviewProductEnrichment: vi.fn(async () => review),
    reviewProduct: vi.fn(),
  };
  state.gate.mockImplementation(async (_name: string, call: () => unknown) => call());
});

it("runs enrichment after collection and returns its independent Review with the collected product", async () => {
  const result = await ProductPipelineWorkflow(input);
  expect(result).toEqual({ status: "collected", operationId: "collected-one", enrichment: review });
  expect(state.collect.mock.invocationCallOrder[0]).toBeLessThan(
    state.child.mock.invocationCallOrder[0] ?? 0,
  );
  expect(state.activities["reviewProduct"]).not.toHaveBeenCalled();
});
it("pre-marker histories emit no enrichment command and keep the original result", async () => {
  state.patch = false;
  expect(await ProductPipelineWorkflow(input)).toEqual(state.collection);
  expect(state.child).not.toHaveBeenCalled();
});
it.each(["collected", "formula-linked"])(
  "enriches a %s reused formula with the target identity",
  async (status) => {
    await enrichCollectedResult(input, {
      status,
      operationId: "sibling-label",
      reusedFormula: true,
      observation: { listingId: "selected", variantId: "120" },
    });
    expect(state.child).toHaveBeenCalledWith(
      "ProductEnrichmentWorkflow",
      expect.objectContaining({
        args: [
          {
            request: {
              channel: "gnc",
              collectionOperationId: "sibling-label",
              captureOperationId: input.operationId,
              listingId: "selected",
              variantId: "120",
            },
            activitiesQueue: input.queues.activities,
          },
        ],
        retry: { maximumAttempts: 1 },
      }),
    );
  },
);
it.each(["review", "formula-pending", "no-amazon-source", "listing"])(
  "does not enrich %s without a formula",
  async (status) => {
    const result = { status };
    expect(await enrichCollectedResult(input, result)).toEqual(result);
    expect(state.child).not.toHaveBeenCalled();
  },
);
it("a failed child preserves the collection and records an enrichment Review", async () => {
  state.child.mockRejectedValue(new Error("worker unavailable"));
  expect(await ProductPipelineWorkflow(input)).toMatchObject({
    status: "collected",
    enrichment: review,
  });
  expect(state.activities["reviewProductEnrichment"]).toHaveBeenCalledOnce();
});
it("preserves the complete observation and collection metadata in the returned result", async () => {
  const collection = {
    status: "collected",
    operationId: "own-label",
    recordHash: "a".repeat(64),
    observation: {
      listingId: "own",
      variantId: null,
      requestId: "request",
      sourceId: "source",
      brandId: "brand",
      observationId: "observation",
    },
  };
  expect(await enrichCollectedResult(input, collection)).toEqual({
    ...collection,
    enrichment: review,
  });
});
it("backfill and pipeline child execute the same model-permitted non-retrying activity", async () => {
  const request = { collectionOperationId: "own-label", channel: "gnc" };
  expect(await ProductEnrichmentWorkflow({ request, activitiesQueue: "pipeline" })).toEqual(review);
  expect(state.gate).toHaveBeenCalledWith("enrichCollectedProduct", expect.any(Function));
  expect(state.activities["enrichCollectedProduct"]).toHaveBeenCalledWith(request);
});
