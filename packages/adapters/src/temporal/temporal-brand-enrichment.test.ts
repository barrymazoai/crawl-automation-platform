import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { WorkflowNotFoundError, type Client } from "@temporalio/client";
import { BrandEnrichmentWorkflowSettingsSchema } from "@crawl-automation/v3-contracts";
import { TemporalBrandEnrichment } from "./temporal-brand-enrichment.js";

function fixture() {
  const needs = [{ resourceId: "model", units: 1 }];
  const settings = BrandEnrichmentWorkflowSettingsSchema.parse({
    taskQueue: "brands",
    queues: { activities: "activities", model: "model", browser: "browser" },
    resources: {
      queue: "resources",
      activities: Object.fromEntries(
        ["brandFamily", "brandResearch", "brandApollo", "brandContacts", "brandReview"].map(
          (name) => [name, needs],
        ),
      ),
    },
  });
  const start = vi.fn();
  const describe = vi.fn(async () => ({ status: { name: "RUNNING" } }));
  const getHandle = vi.fn(() => ({ describe }));
  const service = new TemporalBrandEnrichment(
    { workflow: { start, getHandle } } as unknown as Client,
    settings,
  );
  return {
    settings,
    start,
    describe,
    getHandle,
    service,
    request: { runId: randomUUID(), attempt: 2 },
  };
}

it("starts a products-only workflow on the configured queue with identical settings and no retries", async () => {
  const test = fixture();
  await test.service.startProductsRetry(test.request);
  expect(test.start).toHaveBeenCalledExactlyOnceWith("BrandProductsRetryWorkflow", {
    workflowId: `brand-products-retry-${test.request.runId}-2`,
    taskQueue: test.settings.taskQueue,
    workflowIdReusePolicy: "REJECT_DUPLICATE",
    workflowIdConflictPolicy: "FAIL",
    retry: { maximumAttempts: 1 },
    args: [{ ...test.request, settings: test.settings }],
  });
});

it("describes the exact attempt and preserves an absent workflow as unknown", async () => {
  const test = fixture();
  expect(await test.service.describeProductsRetry(test.request)).toEqual({ status: "RUNNING" });
  expect(test.getHandle).toHaveBeenCalledWith(`brand-products-retry-${test.request.runId}-2`);
  test.describe.mockRejectedValue(new WorkflowNotFoundError("missing", "workflow", undefined));
  expect(await test.service.describeProductsRetry(test.request)).toBeNull();
});

it("propagates start and inspection failures without automatic retries", async () => {
  const test = fixture();
  const error = new Error("connection lost");
  test.start.mockRejectedValue(error);
  await expect(test.service.startProductsRetry(test.request)).rejects.toBe(error);
  expect(test.start).toHaveBeenCalledOnce();
  test.describe.mockRejectedValue(error);
  await expect(test.service.describeProductsRetry(test.request)).rejects.toBe(error);
});
