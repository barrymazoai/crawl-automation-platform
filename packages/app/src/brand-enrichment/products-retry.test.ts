import { expect, it, vi } from "vitest";
import { BrandEnrichmentService } from "./brand-enrichment-service.js";
import { seededRuns } from "./testing/memory-runs.js";
import { companies, requests, reviews } from "./testing/fakes.js";

async function fixture() {
  const store = await seededRuns();
  await store.runs.update(store.runId, { state: "completed" });
  const gateway = {
    start: vi.fn(),
    cancel: vi.fn(),
    describe: vi.fn(),
    startProductsRetry: vi.fn(),
    describeProductsRetry: vi.fn<() => Promise<{ status: string } | null>>(async () => ({
      status: "COMPLETED",
    })),
  };
  const request = requests();
  const company = companies();
  const service = new BrandEnrichmentService({
    ...store,
    gateway,
    requests: request,
    companies: company,
    reviews: reviews(),
  });
  return { ...store, gateway, request, company, service };
}

it.each(["running", "waiting_for_person", "cancelled"] as const)(
  "refuses a %s run",
  async (state) => {
    const test = await fixture();
    await test.runs.update(test.runId, { state });
    await expect(test.service.retryProducts({ runId: test.runId })).rejects.toMatchObject({
      code: "BRAND_ENRICHMENT.INVALID_STATE",
    });
    expect(test.gateway.startProductsRetry).not.toHaveBeenCalled();
    expect(test.runs.saveStep).not.toHaveBeenCalled();
  },
);

it.each(["completed", "failed"] as const)(
  "reserves attempts 2 then 3 for a %s run without reopening it",
  async (state) => {
    const test = await fixture();
    const { runId } = test;
    await test.runs.update(runId, { state });
    const original = await test.runs.get(runId);
    for (const attempt of [2, 3]) {
      expect(await test.service.retryProducts({ runId })).toEqual({
        runId,
        attempt,
        workflowId: `brand-products-retry-${runId}-${attempt}`,
      });
      expect(await test.runs.step(runId, `products-retry@${attempt}`)).toMatchObject({
        requestedAt: expect.any(String),
      });
      expect(test.gateway.startProductsRetry).toHaveBeenCalledWith({ runId, attempt });
    }
    expect(test.gateway.describeProductsRetry).toHaveBeenCalledExactlyOnceWith({
      runId,
      attempt: 2,
    });
    expect(await test.runs.get(runId)).toEqual(original);
    expect(test.request.update).not.toHaveBeenCalled();
    expect(test.company.resolve).not.toHaveBeenCalled();
    expect(test.gateway.start).not.toHaveBeenCalled();
  },
);

it.each([{ status: "RUNNING" }, null])(
  "refuses a pending or unconfirmed retry (%j)",
  async (workflow) => {
    const test = await fixture();
    await test.service.retryProducts({ runId: test.runId });
    test.gateway.describeProductsRetry.mockResolvedValue(workflow);
    await expect(test.service.retryProducts({ runId: test.runId })).rejects.toMatchObject({
      code: "BRAND_ENRICHMENT.INVALID_STATE",
    });
    expect(test.gateway.startProductsRetry).toHaveBeenCalledOnce();
  },
);

it("only one simultaneous caller can publish the reserved attempt", async () => {
  const test = await fixture();
  const results = await Promise.allSettled([
    test.service.retryProducts({ runId: test.runId }),
    test.service.retryProducts({ runId: test.runId }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "BRAND_ENRICHMENT.INVALID_STATE" },
  });
  expect(test.gateway.startProductsRetry).toHaveBeenCalledExactlyOnceWith({
    runId: test.runId,
    attempt: 2,
  });
});

it("uses the highest saved products attempt even when reservations have gaps", async () => {
  const test = await fixture();
  await test.runs.saveStep({
    runId: test.runId,
    step: "products-failure@9",
    output: { reason: "failed" },
    archiveKeys: [],
  });
  expect(await test.service.retryProducts({ runId: test.runId })).toMatchObject({ attempt: 10 });
  expect(test.gateway.describeProductsRetry).toHaveBeenCalledWith({
    runId: test.runId,
    attempt: 9,
  });
});

it("retains a reservation on unknown start publication and never automatically retries it", async () => {
  const test = await fixture();
  test.gateway.startProductsRetry.mockRejectedValue(new Error("publication unknown"));
  test.gateway.describeProductsRetry.mockResolvedValue(null);
  await expect(test.service.retryProducts({ runId: test.runId })).rejects.toThrow(
    "publication unknown",
  );
  expect(await test.runs.step(test.runId, "products-retry@2")).toBeTruthy();
  await expect(test.service.retryProducts({ runId: test.runId })).rejects.toMatchObject({
    code: "BRAND_ENRICHMENT.INVALID_STATE",
  });
  expect(test.gateway.startProductsRetry).toHaveBeenCalledOnce();
});
