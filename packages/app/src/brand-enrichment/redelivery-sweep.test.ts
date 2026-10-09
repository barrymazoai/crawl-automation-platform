import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createLogger } from "@crawl-automation/platform";
import { BrandRedeliverySweep } from "./redelivery-sweep.js";
import { BrandProductRedelivery } from "./product-redelivery.js";
import type { BrandRedeliveryCandidates } from "./redelivery-candidates.js";
import type { ProductDelivery } from "./task-ports.js";
import { seededRuns } from "./testing/memory-runs.js";
import { signal } from "./testing/fakes.js";
import { requireRun } from "./run-records.js";

afterEach(() => vi.useRealTimers());

async function fixture() {
  const store = await seededRuns();
  const late = [store.runId, randomUUID()];
  const unchanged = randomUUID();
  const template = await requireRun(store.runs, store.runId);
  for (const runId of [...late, unchanged]) {
    store.records.set(runId, { ...template, runId, state: "completed" });
    await store.runs.saveStep({
      runId,
      step: "product-sources",
      archiveKeys: [],
      output: {
        created: [],
        matched: [],
        skipped: [],
        tasks: [
          { name: "Example", brandId: randomUUID(), sourceId: randomUUID(), scanId: randomUUID() },
        ],
      },
    });
  }
  const candidates = {
    findPending: vi.fn<BrandRedeliveryCandidates["findPending"]>(async () => late),
  };
  const delivery = {
    deliver: vi.fn<ProductDelivery["deliver"]>(async () => ({
      captured: 1,
      delivered: 1,
      review: 0,
      refused: [],
    })),
  };
  const log = createLogger({ name: "test", level: "fatal" });
  const info = vi.spyOn(log, "info");
  const warn = vi.spyOn(log, "warn");
  const redelivery = new BrandProductRedelivery({ runs: store.runs, delivery });
  const sweep = new BrandRedeliverySweep({ candidates, redelivery, log, lookbackDays: 30 });
  return { ...store, late, unchanged, candidates, delivery, sweep, info, warn };
}

it("delivers each selected late run once with its original ingest ID and logs every result", async () => {
  vi.useFakeTimers().setSystemTime(new Date("2026-10-09T00:00:00Z"));
  const test = await fixture();
  test.candidates.findPending.mockResolvedValue([...test.late, test.runId]);
  await test.sweep.sweep(signal);
  expect(test.candidates.findPending).toHaveBeenCalledWith(new Date("2026-09-09T00:00:00Z"));
  expect(test.delivery.deliver.mock.calls.map(([input]) => input.ingestRunId)).toEqual(
    test.late.map((runId) => `brand-enrichment-${runId}`),
  );
  expect(test.info).toHaveBeenCalledTimes(2);
  for (const runId of test.late) {
    expect(test.info).toHaveBeenCalledWith(
      { runId, result: expect.objectContaining({ delivered: 1 }) },
      "brand product redelivery finished",
    );
    expect(
      [...test.steps.keys()].some((key) => key.startsWith(`${runId}/products-redelivery-`)),
    ).toBe(true);
  }
  expect(
    [...test.steps.keys()].some((key) => key.startsWith(`${test.unchanged}/products-redelivery-`)),
  ).toBe(false);
});

it("logs a failed run and still delivers the next run", async () => {
  const test = await fixture();
  const failure = new Error("Supply Smart unavailable");
  test.delivery.deliver.mockRejectedValueOnce(failure);
  await test.sweep.sweep(signal);
  expect(test.delivery.deliver).toHaveBeenCalledTimes(2);
  expect(test.warn).toHaveBeenCalledWith(
    { runId: test.late[0], err: failure },
    "brand product redelivery failed",
  );
  expect(test.info).toHaveBeenCalledOnce();
});

it("does no work for an empty selection or an already aborted sweep", async () => {
  const test = await fixture();
  test.candidates.findPending.mockResolvedValue([]);
  await test.sweep.sweep(signal);
  await expect(test.sweep.sweep(AbortSignal.abort())).rejects.toThrow();
  expect(test.candidates.findPending).toHaveBeenCalledOnce();
  expect(test.delivery.deliver).not.toHaveBeenCalled();
});
