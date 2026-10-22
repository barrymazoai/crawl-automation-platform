import { expect, it, vi } from "vitest";
import { SiteAnalysisSchema } from "@crawl-automation/v3-contracts";
import {
  ApplySiteAnalysisSchema,
  SiteAnalysisService,
  type SiteAnalysisStore,
} from "./site-analysis-service.js";
import { SiteAnalysisRunner } from "./site-analysis-runner.js";
import { appErrors } from "../errors.js";
const analysisId = "11111111-1111-4111-8111-111111111111";
const record = SiteAnalysisSchema.parse({
  analysisId,
  url: "https://store.example/",
  limits: {},
  state: "queued",
  brands: [],
  archiveKeys: [],
  reasons: [],
});
function setup() {
  const store = {
    create: vi.fn(async () => record),
    get: vi.fn(async () => record),
    running: vi.fn(),
    evidence: vi.fn(),
    finish: vi.fn(),
    apply: vi.fn(async () => ({ created: [], matched: [], skipped: [] })),
  } satisfies SiteAnalysisStore;
  const gateway = {
    start: vi.fn(),
    failure: vi.fn<() => Promise<string | null>>(async () => null),
  };
  return {
    store,
    gateway,
    service: new SiteAnalysisService({ store, gateway, limits: record.limits }),
  };
}
it("persists before starting the durable workflow and returns its analysis ID", async () => {
  const { store, gateway, service } = setup();
  expect(await service.analyze({ requestId: analysisId, url: record.url })).toEqual({ analysisId });
  expect(store.create).toHaveBeenCalledWith(
    { requestId: analysisId, url: record.url },
    record.limits,
  );
  expect(gateway.start).toHaveBeenCalledWith(record);
  expect(store.create.mock.invocationCallOrder[0]).toBeLessThan(
    gateway.start.mock.invocationCallOrder[0] ?? 0,
  );
});
it("a terminal workflow failure reconciles a interrupted running analysis without retry", async () => {
  const { service, gateway, store } = setup();
  gateway.failure.mockResolvedValue("Workflow timed_out; automatic retry disabled");
  expect((await service.get(analysisId)).state).toBe("failed");
  expect(store.finish).toHaveBeenCalledOnce();
  expect(gateway.start).not.toHaveBeenCalled();
});
it.each(["queued", "running", "failed"] as const)(
  "does not create anything for %s",
  async (state) => {
    const { service, store } = setup();
    store.get.mockResolvedValue({ ...record, state });
    await expect(service.apply({ requestId: analysisId, analysisId })).rejects.toMatchObject({
      code: "SITE_ANALYSIS.NOT_APPLICABLE",
    });
    expect(store.apply).not.toHaveBeenCalled();
  },
);
it("applies a completed analysis through its atomic repository operation", async () => {
  const { service, store } = setup();
  store.get.mockResolvedValue({ ...record, state: "completed" });
  const input = { requestId: analysisId, analysisId, brands: ["Alpha"] };
  expect(await service.apply(input)).toEqual({ created: [], matched: [], skipped: [] });
  expect(store.apply).toHaveBeenCalledWith(input);
});
it("passes a needs-review analysis to the repository for verified-brand selection", async () => {
  const { service, store } = setup();
  store.get.mockResolvedValue({
    ...record,
    state: "needs-review",
    reasons: ["BRAND_VERIFICATION_INCOMPLETE: Dherbs Active TLS failure"],
  });
  const input = { requestId: analysisId, analysisId, brands: ["Dherbs", "Dherbs Active"] };
  await service.apply(input);
  expect(store.apply).toHaveBeenCalledExactlyOnceWith(input);
});
it.each([
  "Sub-brand domain cap exceeded; nothing may be applied",
  "Page limit of 100 reached; remaining brands unverified",
  "DTC.ANALYSIS_LIMIT",
  "SITE_ANALYSIS.LIMITS_REACHED",
])("refuses a limits-reached analysis: %s", async (reason) => {
  const { service, store } = setup();
  store.get.mockResolvedValue({ ...record, state: "needs-review", reasons: [reason] });
  await expect(service.apply({ requestId: analysisId, analysisId })).rejects.toMatchObject({
    code: "SITE_ANALYSIS.NOT_APPLICABLE",
  });
  expect(store.apply).not.toHaveBeenCalled();
});
it("accepts explicit settings correction for a completed analysis", async () => {
  const { service, store } = setup();
  store.get.mockResolvedValue({ ...record, state: "completed" });
  const input = { requestId: analysisId, analysisId, replaceSettings: true };
  expect(ApplySiteAnalysisSchema.parse(input)).toEqual(input);
  await service.apply(input);
  expect(store.apply).toHaveBeenCalledWith(input);
});
it("rejects a settings correction combined with scan enqueue", async () => {
  const { service, store } = setup();
  await expect(
    service.apply({
      requestId: analysisId,
      analysisId,
      replaceSettings: true,
      enqueue: true,
    }),
  ).rejects.toThrow();
  expect(store.apply).not.toHaveBeenCalled();
});
it("runner persists each archive key before analysis continues and records success", async () => {
  const { store } = setup();
  const result = {
    state: "completed" as const,
    brands: [],
    archiveKeys: ["original"],
    reasons: [],
  };
  const runner = new SiteAnalysisRunner({
    store,
    analyze: async (_input, evidence) => {
      await evidence("original");
      expect(store.evidence).toHaveBeenCalledWith(analysisId, "original");
      return result;
    },
  });
  expect(await runner.run(record, AbortSignal.timeout(1000))).toEqual(result);
  expect(store.running).toHaveBeenCalledWith(analysisId);
  expect(store.finish).toHaveBeenCalledWith(analysisId, result);
});
it("runner preserves the registered failure and never retries", async () => {
  const { store } = setup();
  const error = appErrors.create("BRAND.NOT_FOUND");
  const analyze = vi.fn(async () => {
    throw error;
  });
  const runner = new SiteAnalysisRunner({ store, analyze });
  await expect(runner.run(record, AbortSignal.timeout(1000))).rejects.toBe(error);
  expect(analyze).toHaveBeenCalledOnce();
  expect(store.finish).toHaveBeenCalledWith(
    analysisId,
    expect.objectContaining({ state: "failed", reasons: ["BRAND.NOT_FOUND"] }),
  );
});
