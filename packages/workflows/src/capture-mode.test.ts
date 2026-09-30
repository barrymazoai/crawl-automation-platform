import { beforeEach, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  patched: vi.fn(() => true),
  browser: vi.fn(async () => ({ status: "browser-result" })),
  http: vi.fn(async () => ({ status: "http-result" })),
}));

vi.mock("@temporalio/workflow", () => ({
  patched: env.patched,
  proxyActivities: () => ({}),
  isCancellation: () => false,
}));
vi.mock("./browser-product.js", () => ({ collectInBrowser: env.browser }));
vi.mock("./resources/capture-product.js", () => ({ captureProduct: env.http }));
vi.mock("./stream-label.js", () => ({ streamLabel: vi.fn() }));
vi.mock("./sibling-reuse.js", () => ({ reuseSiblingFormula: vi.fn() }));

import { ProductPipelineWorkflow } from "./product-pipeline-workflow.js";

const input = {
  codec: "product-pipeline/1",
  runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  channel: "wholefoods",
  url: "https://example.com/product",
  brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  operationId: "capture-1",
  queues: { activities: "pipeline", plan: "plan", label: "label", browser: "browser" },
  resources: { queue: "resource", activities: {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  env.patched.mockReturnValue(true);
});

it.each(["swanson", "gnc", "amazon", "wholefoods", "dtc", "costco"])(
  "routes %s by capture mode, independently of the channel name",
  async (channel) => {
    expect(await ProductPipelineWorkflow({ ...input, channel, capture: "browser" })).toEqual({
      status: "browser-result",
    });
    expect(await ProductPipelineWorkflow({ ...input, channel, capture: "http" })).toEqual({
      status: "http-result",
    });
    expect(env.patched).toHaveBeenCalledWith("capture-mode-v1");
  },
);

it.each([
  ["wholefoods", "browser-result"],
  ["amazon", "http-result"],
])(
  "preserves absent-field histories for %s without introducing a marker",
  async (channel, status) => {
    expect(await ProductPipelineWorkflow({ ...input, channel })).toEqual({ status });
    expect(env.patched).not.toHaveBeenCalledWith("capture-mode-v1");
  },
);

it("preserves the old decision when replay has no capture marker", async () => {
  env.patched.mockReturnValue(false);
  expect(await ProductPipelineWorkflow({ ...input, capture: "http" })).toEqual({
    status: "browser-result",
  });
  expect(await ProductPipelineWorkflow({ ...input, channel: "gnc", capture: "browser" })).toEqual({
    status: "http-result",
  });
});

it("refuses an unsupported capture mode before any activity", async () => {
  await expect(ProductPipelineWorkflow({ ...input, capture: "other" })).rejects.toThrow();
  expect(env.http).not.toHaveBeenCalled();
  expect(env.browser).not.toHaveBeenCalled();
});
