import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { SiteAnalysisSchema } from "@crawl-automation/v3-contracts";
import {
  SiteAnalysisService,
  type SiteAnalysisStore,
} from "../site-analysis/site-analysis-service.js";
import { BrandProductsService } from "./products-service.js";
import { seededRuns } from "./testing/memory-runs.js";
import { signal } from "./testing/fakes.js";
import type { ProductDelivery } from "./task-ports.js";

async function fixture() {
  const store = await seededRuns();
  const analysis = SiteAnalysisSchema.parse({
    analysisId: randomUUID(),
    url: "https://example.test",
    state: "completed",
    brands: [],
    archiveKeys: [],
    reasons: [],
    limits: {},
  });
  const task = {
    name: "Example",
    brandId: randomUUID(),
    sourceId: randomUUID(),
    scanId: randomUUID(),
  };
  const progress = {
    ...task,
    catalogUrl: "https://example.test/all",
    state: "complete" as const,
    code: null,
    catalogComplete: true,
    discovered: 3,
    products: { running: 1, review: 1, completed: 1 },
  };
  const apply = vi.fn<SiteAnalysisStore["apply"]>(async () => ({
    created: [task],
    matched: [],
    skipped: [],
    tasks: [task],
  }));
  const analyses = new SiteAnalysisService({
    store: {
      create: vi.fn(async () => analysis),
      get: vi.fn(async () => analysis),
      running: vi.fn(),
      evidence: vi.fn(),
      finish: vi.fn(),
      apply,
      tasks: vi.fn(async () => [progress]),
    },
    gateway: { start: vi.fn(), failure: vi.fn(async () => null) },
    limits: analysis.limits,
    canEnqueue: true,
  });
  const delivery = {
    deliver: vi.fn<ProductDelivery["deliver"]>(async () => ({
      captured: 2,
      review: 1,
      delivered: 1,
      refused: [{ externalId: "one", reason: "duplicate" }],
    })),
  };
  const execution = { stop: vi.fn() };
  return {
    ...store,
    analysis,
    progress,
    task,
    apply,
    delivery,
    execution,
    service: new BrandProductsService({ ...store, analyses, delivery, execution }),
  };
}
it("waits for the brand's queued products, then delivers its sources once while retaining Reviews", async () => {
  const test = await fixture();
  expect(await test.service.tick(test.runId, signal)).toEqual({ done: false });
  expect(test.delivery.deliver).not.toHaveBeenCalled();
  test.progress.products.running = 0;
  test.progress.products.completed = 2;
  expect(await test.service.tick(test.runId, signal)).toEqual({ done: true });
  expect(test.apply).toHaveBeenCalledOnce();
  expect(test.delivery.deliver).toHaveBeenCalledWith(
    {
      companyId: test.companyId,
      siteKey: "example.test",
      sourceIds: [test.task.sourceId],
      ingestRunId: `brand-enrichment-${test.runId}`,
    },
    signal,
  );
  await test.service.tick(test.runId, signal);
  expect(test.delivery.deliver).toHaveBeenCalledOnce();
  expect(await test.runs.step(test.runId, "products")).toMatchObject({
    captured: 2,
    review: 1,
    refused: [{ externalId: "one", reason: "duplicate" }],
  });
});
it("a not-nutrition analysis never applies or delivers products", async () => {
  const test = await fixture();
  test.analysis.state = "skipped";
  await test.service.tick(test.runId, signal);
  expect(test.apply).not.toHaveBeenCalled();
  expect(test.delivery.deliver).not.toHaveBeenCalled();
});
it("cancellation passes only the recorded analysis and its exact scans to execution cleanup", async () => {
  const test = await fixture();
  await test.service.tick(test.runId, signal);
  await test.service.stop(test.runId);
  expect(test.execution.stop).toHaveBeenCalledWith({
    analysisId: test.analysis.analysisId,
    scanIds: [test.task.scanId],
  });
});
