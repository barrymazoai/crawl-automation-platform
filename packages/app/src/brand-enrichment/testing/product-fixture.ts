import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { SiteAnalysisSchema } from "@crawl-automation/v3-contracts";
import {
  SiteAnalysisService,
  type SiteAnalysisStore,
} from "../../site-analysis/site-analysis-service.js";
import { BrandProductsService } from "../products-service.js";
import type { ProductDelivery } from "../task-ports.js";
import { seededRuns } from "./memory-runs.js";

function analysisState() {
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
  return { analysis, task, progress };
}

function analysisPort(state: ReturnType<typeof analysisState>) {
  const { analysis, task, progress } = state;
  const store = {
    create: vi.fn<SiteAnalysisStore["create"]>(async () => analysis),
    get: vi.fn(async () => analysis),
    running: vi.fn(),
    evidence: vi.fn(),
    finish: vi.fn(),
    apply: vi.fn<SiteAnalysisStore["apply"]>(async () => ({
      created: [task],
      matched: [],
      skipped: [],
      tasks: [task],
    })),
    tasks: vi.fn(async () => [progress]),
  };
  const analyses = new SiteAnalysisService({
    store,
    gateway: { start: vi.fn(), failure: vi.fn(async () => null) },
    limits: analysis.limits,
    canEnqueue: true,
  });
  return { analyses, create: store.create, apply: store.apply };
}

export async function productFixture() {
  const store = await seededRuns();
  const state = analysisState();
  const analysis = analysisPort(state);
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
    ...state,
    ...analysis,
    delivery,
    execution,
    service: new BrandProductsService({
      runs: store.runs,
      analyses: analysis.analyses,
      delivery,
      execution,
    }),
  };
}
