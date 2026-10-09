import { randomUUID } from "node:crypto";
import { expect, it, vi, beforeEach } from "vitest";
import { BrandEnrichmentWorkflowSettingsSchema } from "@crawl-automation/v3-contracts";
import { BrandEnrichmentWorkflow } from "./brand-enrichment-workflow.js";

const mocks = vi.hoisted(() => ({
  plain: {
    brandIdentity: vi.fn(),
    brandWrite: vi.fn(),
    brandOwnershipWrite: vi.fn(),
    brandClose: vi.fn(),
    brandProducts: vi.fn(),
    brandProductsStop: vi.fn(),
    brandProductFailure: vi.fn(),
  },
  gated: vi.fn(),
  child: vi.fn(),
}));
vi.mock("./brand-enrichment-routing.js", () => ({ brandEnrichmentActivities: () => mocks }));
vi.mock("@temporalio/workflow", () => ({
  CancellationScope: class {
    static nonCancellable(operation: () => Promise<void>) {
      return operation();
    }
    run(operation: () => Promise<void>) {
      return operation();
    }
    cancel() {
      return undefined;
    }
  },
  ChildWorkflowCancellationType: { WAIT_CANCELLATION_COMPLETED: "wait" },
  ParentClosePolicy: { REQUEST_CANCEL: "request" },
  executeChild: mocks.child,
  isCancellation: (error: unknown) => error instanceof Error && error.name === "CancelledFailure",
  sleep: async () => undefined,
}));
function input() {
  const needs = [{ resourceId: "mini-model-account", units: 1 }];
  return {
    runId: randomUUID(),
    settings: BrandEnrichmentWorkflowSettingsSchema.parse({
      taskQueue: "brands",
      queues: { activities: "brands", model: "model", browser: "browser" },
      resources: {
        queue: "resources",
        activities: Object.fromEntries(
          ["brandFamily", "brandResearch", "brandApollo", "brandContacts", "brandReview"].map(
            (name) => [name, needs],
          ),
        ),
      },
    }),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.plain.brandIdentity.mockResolvedValue({ role: "request", hasWebsite: true });
  mocks.gated.mockImplementation(async (name) =>
    name === "brandFamily"
      ? { children: [], products: true }
      : name === "brandReview"
        ? {}
        : undefined,
  );
  mocks.plain.brandProducts.mockResolvedValue({ done: true });
});
it("a product track failure is retained and the brand still writes its profile and completes", async () => {
  mocks.plain.brandProducts.mockRejectedValue(new Error("one delivery failed"));
  await BrandEnrichmentWorkflow(input());
  expect(mocks.plain.brandProductFailure).toHaveBeenCalledOnce();
  expect(mocks.plain.brandProductsStop).toHaveBeenCalledOnce();
  expect(mocks.plain.brandWrite).toHaveBeenCalledOnce();
  expect(mocks.plain.brandClose).toHaveBeenCalledWith(
    expect.objectContaining({ state: "completed" }),
  );
});
it("waits for a sibling to settle before closing a failed run", async () => {
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.gated.mockImplementation((name) => {
    if (name === "brandFamily") {
      return Promise.resolve({ children: [], products: false });
    }
    if (name === "brandResearch") {
      return Promise.reject(new Error("research failure"));
    }
    return pending;
  });
  const execution = BrandEnrichmentWorkflow(input());
  await vi.waitFor(() =>
    expect(mocks.gated).toHaveBeenCalledWith("brandApollo", expect.anything()),
  );
  expect(mocks.plain.brandClose).not.toHaveBeenCalled();
  release?.();
  await expect(execution).rejects.toThrow("research failure");
  expect(mocks.plain.brandClose).toHaveBeenCalledWith(expect.objectContaining({ state: "failed" }));
});
it("cancellation uses the non-cancellable cleanup and records cancelled", async () => {
  const error = Object.assign(new Error("cancel"), { name: "CancelledFailure" });
  mocks.plain.brandIdentity.mockRejectedValue(error);
  await expect(BrandEnrichmentWorkflow(input())).rejects.toBe(error);
  expect(mocks.plain.brandProductsStop).toHaveBeenCalledOnce();
  expect(mocks.plain.brandClose).toHaveBeenCalledWith(
    expect.objectContaining({ state: "cancelled" }),
  );
});
it("owners skip family discovery and products", async () => {
  mocks.plain.brandIdentity.mockResolvedValue({ role: "owner", hasWebsite: true });
  await BrandEnrichmentWorkflow(input());
  expect(mocks.gated).not.toHaveBeenCalledWith("brandFamily", expect.anything());
  expect(mocks.plain.brandProducts).not.toHaveBeenCalled();
});
