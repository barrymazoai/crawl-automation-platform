import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { BrandProductRedelivery } from "./product-redelivery.js";
import type { ProductDelivery } from "./task-ports.js";
import { seededRuns } from "./testing/memory-runs.js";

const signal = new AbortController().signal;
afterEach(() => vi.useRealTimers());

async function fixture(state: "running" | "completed") {
  const test = await seededRuns();
  await test.runs.update(test.runId, { state });
  const sourceId = randomUUID();
  await test.runs.saveStep({
    runId: test.runId,
    step: "product-sources",
    output: {
      created: [],
      matched: [],
      skipped: [],
      tasks: [
        {
          name: "Example",
          brandId: randomUUID(),
          sourceId,
          scanId: randomUUID(),
          catalogUrl: "https://example.test/collections/all",
        },
      ],
    },
    archiveKeys: [],
  });
  const delivery = {
    catalogs: vi.fn<ProductDelivery["catalogs"]>(async (sourceIds) =>
      sourceIds.map((sourceId) => ({ sourceId, catalogUrl: "https://example.test/all" })),
    ),
    deliver: vi.fn<ProductDelivery["deliver"]>(async () => ({
      captured: 3,
      review: 1,
      delivered: 3,
      refused: [],
    })),
  };
  return {
    ...test,
    sourceId,
    delivery,
    service: new BrandProductRedelivery({ runs: test.runs, delivery }),
  };
}

it("delivers a closed run's products again through the same Supply Smart ingest run", async () => {
  const test = await fixture("completed");
  const result = await test.service.deliver(test.runId, signal);
  expect(test.delivery.deliver).toHaveBeenCalledWith(
    {
      companyId: test.companyId,
      siteKey: "example.test",
      sourceIds: [test.sourceId],
      ingestRunId: `brand-enrichment-${test.runId}`,
    },
    signal,
  );
  expect(result).toMatchObject({ runId: test.runId, delivered: 3 });
});

it("refuses a run that still delivers its own products, and a run without product sources", async () => {
  const running = await fixture("running");
  await expect(running.service.deliver(running.runId, signal)).rejects.toMatchObject({
    code: "BRAND_ENRICHMENT.INVALID_STATE",
  });
  const bare = await seededRuns();
  await bare.runs.update(bare.runId, { state: "completed" });
  const service = new BrandProductRedelivery({ runs: bare.runs, delivery: running.delivery });
  await expect(service.deliver(bare.runId, signal)).rejects.toMatchObject({
    code: "BRAND_ENRICHMENT.INVALID_STATE",
  });
  expect(running.delivery.deliver).not.toHaveBeenCalled();
});

it("saves the delivery start time so products completing during delivery are not missed", async () => {
  vi.useFakeTimers().setSystemTime(new Date("2026-10-09T00:00:00Z"));
  const test = await fixture("completed");
  test.delivery.deliver.mockImplementationOnce(async () => {
    vi.setSystemTime(new Date("2026-10-09T00:05:00Z"));
    return { captured: 3, review: 1, delivered: 3, refused: [] };
  });
  await test.service.deliver(test.runId, signal);
  expect(
    await test.runs.step(test.runId, "products-redelivery-2026-10-09T00:05:00.000Z"),
  ).toMatchObject({ deliveryStartedAt: "2026-10-09T00:00:00.000Z" });
});

it("delivers only the latest attempt's sources and tags the redelivery snapshot", async () => {
  vi.useFakeTimers().setSystemTime(new Date("2026-10-09T00:00:00Z"));
  const test = await fixture("completed");
  const sourceId = randomUUID();
  await test.runs.saveStep({
    runId: test.runId,
    step: "product-sources@2",
    archiveKeys: [],
    output: {
      created: [],
      matched: [],
      skipped: [],
      tasks: [{ name: "Retry", sourceId, brandId: randomUUID(), scanId: randomUUID() }],
    },
  });
  await test.service.deliver(test.runId, signal);
  expect(test.delivery.deliver).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      sourceIds: [sourceId],
      ingestRunId: `brand-enrichment-${test.runId}`,
    }),
    signal,
  );
  expect(
    await test.runs.step(test.runId, "products-redelivery-2026-10-09T00:00:00.000Z"),
  ).toMatchObject({ attempt: 2 });
});

it("never falls back to old sources while a newly reserved attempt has no sources", async () => {
  const test = await fixture("completed");
  await test.runs.saveStep({
    runId: test.runId,
    step: "products-retry@2",
    output: { requestedAt: new Date().toISOString() },
    archiveKeys: [],
  });
  await expect(test.service.deliver(test.runId, signal)).rejects.toMatchObject({
    code: "BRAND_ENRICHMENT.INVALID_STATE",
  });
  expect(test.delivery.deliver).not.toHaveBeenCalled();
});
