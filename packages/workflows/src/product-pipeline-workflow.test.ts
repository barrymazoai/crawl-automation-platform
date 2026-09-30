import { beforeEach, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  activities: {} as Record<string, unknown>,
  start: vi.fn(),
  signals: [] as Array<[string, unknown]>,
  held: false,
  /** Whether the history being run carries the patch markers (false: a history recorded before them). */
  patched: true,
}));

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
    proxyActivities: ({ taskQueue }: { taskQueue: string }) => env.activities[taskQueue],
    startChild: env.start,
    workflowInfo: () => ({
      workflowId: "product-run-1",
      runId: "00000000-0000-4000-8000-000000000001",
    }),
    patched: () => env.patched,
    sleep: async () => undefined,
    isCancellation: (error: unknown) => (error as { type?: string }).type === "CANCELLED",
    CancellationScope: { nonCancellable: (run: () => unknown) => run() },
    ParentClosePolicy: { REQUEST_CANCEL: "REQUEST_CANCEL" },
    WorkflowIdReusePolicy: { REJECT_DUPLICATE: "REJECT_DUPLICATE" },
    ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
    ActivityFailure: class extends Error {},
    ApplicationFailure,
  };
});

import { swansonLiveFixture } from "@crawl-automation/v3-channels/testing/swanson-live";
import { ProductPipelineWorkflow } from "./product-pipeline-workflow.js";

const signal = () => AbortSignal.timeout(5000);

const input = {
  codec: "product-pipeline/1",
  runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  channel: "swanson",
  url: "https://www.swansonvitamins.com/p/synthetic",
  brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  operationId: "pipeline-capture-1",
  queues: { activities: "pipeline", plan: "plan", label: "label" },
  resources: {
    queue: "resource",
    releaseOnReview: true,
    activities: { captureProduct: [{ resourceId: "swanson-http-lane", units: 1 }] },
  },
};

const review = {
  status: "review",
  operationId: "pipeline-capture-1",
  reviewId: "review-1",
  code: "PIPELINE.PRODUCT_UNRESOLVED",
  evidenceKey: "reviews/one.json",
  automaticRetry: false,
};

interface Acquire {
  acquire: { operationId: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  env.signals = [];
  env.held = false;
  env.patched = true;
});

async function setup() {
  const fixture = swansonLiveFixture();
  const { sourcePlan } = await fixture.live.capture(await fixture.job(), signal());
  const file = {
    ...sourcePlan.source,
    kind: "source-image",
    mediaType: "image/jpeg",
    producer: { operationId: "file", module: "file.acquire", implementationVersion: "1" },
  };
  const pipeline = {
    captureProduct: vi.fn(async (): Promise<unknown> => {
      expect(env.held).toBe(true);
      return { status: "captured", sourcePlan, factsComplete: false };
    }),
    findKnownFormula: vi.fn(async (): Promise<unknown> => null),
    reuseSiblingFormula: vi.fn(async (): Promise<unknown> => ({
      status: "extract",
      reason: "FORMULA.NO_SIBLING_FORMULA",
    })),
    prepareLabelHandoff: vi.fn(async () => {
      expect(env.held).toBe(false);
      return { input: { operationId: "label-1" } };
    }),
    prepareLabelTask: vi.fn(async () => {
      expect(env.held).toBe(false);
      return { input: { operationId: "label-1" } };
    }),
    acquireProductFile: vi.fn(async ({ acquire }: Acquire): Promise<unknown> => ({
      status: "durable",
      operationId: acquire.operationId,
      evidenceKey: "files/one.json",
      file,
    })),
    reviewProduct: vi.fn(async () => review),
  };
  const plan = {
    prepareChannelProduct: vi.fn((raw: unknown): Promise<unknown> =>
      fixture.plans.run(raw, signal()),
    ),
  };
  const resource = {
    reserveResources: vi.fn(async (request: { permitId: string }) => {
      env.held = true;
      return { permitId: request.permitId, status: "granted", reason: "available" };
    }),
    releaseResources: vi.fn(async (request: { permitId: string }) => {
      env.held = false;
      return { permitId: request.permitId, status: "released", reason: "released" };
    }),
  };
  env.activities = { pipeline, plan, resource };
  env.start.mockResolvedValue({
    signal: vi.fn(async (name: string, body: unknown) => {
      env.signals.push([name, body]);
    }),
    result: async () => ({ status: "collected", operationId: "label-1" }),
  });
  return { pipeline, plan, resource };
}

it("captures on the lane, plans, then streams every label image to the label workflow and seals it", async () => {
  const { pipeline } = await setup();

  expect(await ProductPipelineWorkflow(input)).toEqual({
    status: "collected",
    operationId: "label-1",
  });

  expect(env.start).toHaveBeenCalledWith(
    "LabelWorkflow",
    expect.objectContaining({
      workflowId: "product-run-1-label",
      taskQueue: "label",
      parentClosePolicy: "REQUEST_CANCEL",
    }),
  );
  expect(pipeline.prepareLabelTask).toHaveBeenCalledOnce();
  expect(pipeline.prepareLabelHandoff).not.toHaveBeenCalled();
  expect(pipeline.acquireProductFile).toHaveBeenCalled();
  const names = env.signals.map(([name]) => name);
  expect(names.filter((name) => name === "labelSourceReady")).toHaveLength(
    pipeline.acquireProductFile.mock.calls.length,
  );
  expect(env.signals.at(-1)).toEqual([
    "labelStreamSealed",
    { operationId: "label-1", status: "closed" },
  ]);
  expect(env.held).toBe(false);
});

it("a history recorded before the shared Label workflow keeps streaming to the earlier per-channel one", async () => {
  const { pipeline } = await setup();
  env.patched = false;

  await ProductPipelineWorkflow(input);

  expect(env.start).toHaveBeenCalledWith("ChannelStreamingLabelWorkflow", expect.anything());
  expect(pipeline.prepareLabelHandoff).toHaveBeenCalledOnce();
  expect(pipeline.prepareLabelTask).not.toHaveBeenCalled();
  expect(env.signals.at(-1)?.[0]).toBe("channelStreamSealed");
});

it("a known formula still saves the metrics but reads no label", async () => {
  const { pipeline, plan } = await setup();
  pipeline.findKnownFormula.mockResolvedValue({ operationId: "formula-earlier" });

  expect(await ProductPipelineWorkflow(input)).toMatchObject({
    status: "collected",
    reusedFormula: true,
    operationId: "formula-earlier",
  });
  expect(plan.prepareChannelProduct).toHaveBeenCalledOnce();
  expect(env.start).not.toHaveBeenCalled();
});

it("a capture Review is returned as is, releases the lane and starts nothing else", async () => {
  const { pipeline, plan, resource } = await setup();
  pipeline.captureProduct.mockResolvedValue(review);

  expect(await ProductPipelineWorkflow(input)).toEqual(review);

  expect(resource.releaseResources).toHaveBeenCalledOnce();
  expect(plan.prepareChannelProduct).not.toHaveBeenCalled();
});

it("a listing the revisit found unlisted ends there as a sighting, not a Review", async () => {
  const { pipeline, plan, resource } = await setup();
  const sighted = {
    status: "listing",
    state: "unlisted",
    reason: "not_found",
    operationId: "pipeline-capture-1",
    observationId: "a".repeat(64),
    listingId: "synthetic",
    variantId: null,
    causeCode: "LISTING.NOT_FOUND",
  };
  pipeline.captureProduct.mockResolvedValue(sighted);

  expect(await ProductPipelineWorkflow(input)).toEqual(sighted);

  expect(resource.releaseResources).toHaveBeenCalledOnce();
  expect(plan.prepareChannelProduct).not.toHaveBeenCalled();
  expect(pipeline.reviewProduct).not.toHaveBeenCalled();
});

it("a failed image download seals the stream as failed and returns the file Review", async () => {
  const { pipeline } = await setup();
  pipeline.acquireProductFile.mockImplementation(async ({ acquire }: Acquire) => ({
    ...review,
    code: "FILE.DOWNLOAD_FAILED",
    operationId: acquire.operationId,
  }));

  expect(await ProductPipelineWorkflow(input)).toMatchObject({ code: "FILE.DOWNLOAD_FAILED" });
  expect(env.signals.at(-1)?.[1]).toEqual({ operationId: "label-1", status: "failed" });
});

it("an Activity failure becomes a Review that carries its real cause", async () => {
  const { pipeline, plan } = await setup();
  plan.prepareChannelProduct.mockRejectedValue(
    Object.assign(new Error("activity failed"), { cause: { type: "PLAN.SOURCE_MISSING" } }),
  );

  expect(await ProductPipelineWorkflow(input)).toEqual(review);
  expect(pipeline.reviewProduct).toHaveBeenCalledWith(
    expect.objectContaining({ causeCode: "PLAN.SOURCE_MISSING" }),
  );
});

it("cancellation passes through without a Review", async () => {
  const { pipeline, resource } = await setup();
  pipeline.captureProduct.mockRejectedValue(
    Object.assign(new Error("cancelled"), { type: "CANCELLED" }),
  );

  await expect(ProductPipelineWorkflow(input)).rejects.toMatchObject({ type: "CANCELLED" });
  expect(pipeline.reviewProduct).not.toHaveBeenCalled();
  expect(resource.releaseResources).toHaveBeenCalledOnce();
  expect(env.held).toBe(false);
});

it("capture wait expiry records not_executed without starting capture", async () => {
  const { pipeline, resource } = await setup();
  let now = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  resource.reserveResources.mockImplementation(async ({ permitId }) => {
    now += 10_000;
    return { permitId, status: "waiting", reason: "unhealthy" };
  });
  try {
    await ProductPipelineWorkflow({
      ...input,
      resources: { ...input.resources, maxWaitSeconds: 10 },
    });
    expect(pipeline.reviewProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        causeCode: "RESOURCE.WAIT_LIMIT",
        executionFact: "not_executed",
      }),
    );
    expect(pipeline.captureProduct).not.toHaveBeenCalled();
    expect(resource.releaseResources).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

const family = {
  differsBy: "size",
  group: "Size",
  selectedLabel: "120 Caps",
  members: [
    {
      listingId: "sibling",
      variantId: null,
      url: "https://www.swansonvitamins.com/p/sibling",
      label: "60 Caps",
    },
  ],
};

async function withFamily() {
  const parts = await setup();
  // The capture mock checks the lane permit is held; read its answer as the gate would.
  env.held = true;
  const captured = (await parts.pipeline.captureProduct()) as Record<string, unknown>;
  env.held = false;
  parts.pipeline.captureProduct.mockResolvedValue({
    ...captured,
    family,
    labelText: "D-Ribose 5 g",
  });
  return parts;
}

it("a size sibling's formula, once its label check passes, is reused without reading any label", async () => {
  const { pipeline, plan } = await withFamily();
  pipeline.reuseSiblingFormula.mockResolvedValue({
    status: "reused",
    formulaOperationId: "formula-sibling",
    linkId: "b".repeat(64),
    siblingListingId: "sibling",
    siblingVariantId: null,
  });

  expect(await ProductPipelineWorkflow(input)).toMatchObject({
    status: "collected",
    reusedFormula: true,
    operationId: "formula-sibling",
    reusedFrom: { listingId: "sibling", variantId: null },
  });
  expect(pipeline.reuseSiblingFormula).toHaveBeenCalledWith(
    expect.objectContaining({ family, labelText: "D-Ribose 5 g", channel: "swanson" }),
  );
  expect(plan.prepareChannelProduct).toHaveBeenCalledOnce();
  expect(env.start).not.toHaveBeenCalled();
});

it("without a passed label check the product is extracted as before", async () => {
  const { pipeline } = await withFamily();

  expect(await ProductPipelineWorkflow(input)).toEqual({
    status: "collected",
    operationId: "label-1",
  });
  expect(pipeline.reuseSiblingFormula).toHaveBeenCalledOnce();
  expect(env.start).toHaveBeenCalled();
});

it("a history recorded before the reuse patch replays without the reuse activity", async () => {
  const { pipeline } = await withFamily();
  env.patched = false;

  expect(await ProductPipelineWorkflow(input)).toEqual({
    status: "collected",
    operationId: "label-1",
  });
  expect(pipeline.reuseSiblingFormula).not.toHaveBeenCalled();
});
