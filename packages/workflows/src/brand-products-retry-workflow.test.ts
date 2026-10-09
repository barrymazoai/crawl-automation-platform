import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { BrandProductsRetryWorkflow } from "./brand-products-retry-workflow.js";
import { brandSettings } from "./testing/brand-enrichment-settings.js";

const mocks = vi.hoisted(() => ({
  plain: {
    brandProducts: vi.fn(),
    brandProductsStop: vi.fn(),
    brandProductFailure: vi.fn(),
    brandClose: vi.fn(),
    brandIdentity: vi.fn(),
  },
  gated: vi.fn(),
  sleep: vi.fn(),
  nonCancellable: vi.fn((work: () => Promise<void>) => work()),
}));
vi.mock("./brand-enrichment-routing.js", () => ({ brandEnrichmentActivities: () => mocks }));
vi.mock("@temporalio/workflow", () => ({
  CancellationScope: { nonCancellable: mocks.nonCancellable },
  isCancellation: (error: unknown) => error instanceof Error && error.name === "CancelledFailure",
  sleep: mocks.sleep,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.plain.brandProducts.mockReset();
});
function input() {
  return { runId: randomUUID(), attempt: 2, settings: brandSettings() };
}

it("polls only the existing products loop with the requested attempt", async () => {
  const request = input();
  mocks.plain.brandProducts
    .mockResolvedValueOnce({ done: false })
    .mockResolvedValueOnce({ done: true });
  await BrandProductsRetryWorkflow(request);
  expect(mocks.plain.brandProducts.mock.calls).toEqual([
    [{ runId: request.runId, attempt: 2 }],
    [{ runId: request.runId, attempt: 2 }],
  ]);
  expect(mocks.sleep).toHaveBeenCalledExactlyOnceWith(5000);
  expect(mocks.gated).not.toHaveBeenCalled();
  expect(mocks.plain.brandIdentity).not.toHaveBeenCalled();
  expect(mocks.plain.brandClose).not.toHaveBeenCalled();
  expect(mocks.plain.brandProductsStop).not.toHaveBeenCalled();
});

it.each([false, true])(
  "stops and records a products failure without closing the brand (timeout=%s)",
  async (timeout) => {
    const request = input();
    if (timeout) {
      mocks.plain.brandProducts.mockResolvedValue({ done: false });
    } else {
      mocks.plain.brandProducts.mockRejectedValue(new Error("delivery failed"));
    }
    await BrandProductsRetryWorkflow(request);
    expect(mocks.plain.brandProductsStop).toHaveBeenCalledExactlyOnceWith({
      runId: request.runId,
      attempt: 2,
    });
    expect(mocks.plain.brandProductFailure).toHaveBeenCalledExactlyOnceWith({
      runId: request.runId,
      attempt: 2,
      reason: timeout ? "BRAND_ENRICHMENT.PRODUCTS_TIMEOUT" : "Error: delivery failed",
    });
    expect(mocks.plain.brandClose).not.toHaveBeenCalled();
    expect(mocks.plain.brandProducts).toHaveBeenCalledTimes(timeout ? 2 : 1);
  },
);

it("awaits exact-attempt cleanup in a non-cancellable scope", async () => {
  const request = input();
  const error = Object.assign(new Error("cancel"), { name: "CancelledFailure" });
  mocks.plain.brandProducts.mockRejectedValue(error);
  let release: (() => void) | undefined;
  mocks.plain.brandProductsStop.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const workflow = BrandProductsRetryWorkflow(request);
  await vi.waitFor(() => expect(mocks.plain.brandProductsStop).toHaveBeenCalledOnce());
  expect(mocks.nonCancellable).toHaveBeenCalledOnce();
  expect(mocks.plain.brandProductsStop).toHaveBeenCalledWith({ runId: request.runId, attempt: 2 });
  release?.();
  await expect(workflow).rejects.toBe(error);
  expect(mocks.plain.brandClose).not.toHaveBeenCalled();
});

it("does not report success if cleanup fails", async () => {
  mocks.plain.brandProducts.mockRejectedValue(new Error("delivery failed"));
  mocks.plain.brandProductsStop.mockRejectedValueOnce(new Error("cleanup pending"));
  await expect(BrandProductsRetryWorkflow(input())).rejects.toThrow("cleanup pending");
  expect(mocks.plain.brandProductFailure).not.toHaveBeenCalled();
});
