import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { BrandEnrichmentRun, BrandRequest } from "@crawl-automation/v3-contracts";
import { BrandRequestIntake, type BrandClaimResult } from "./request-intake.js";
import { requests, signal } from "./testing/fakes.js";

const HOUR = 3_600_000;
const NOW = new Date("2026-10-20T12:00:00Z");

function run(over: Partial<BrandEnrichmentRun> = {}): BrandEnrichmentRun {
  return {
    runId: randomUUID(),
    requestId: randomUUID(),
    parentRunId: null,
    role: "request",
    brandName: "Blood Sugar Friendly",
    brandUrl: "https://bloodsugarfriendly.com/",
    companyId: null,
    workflowId: "brand-enrichment-x",
    state: "running",
    stage: "products",
    summary: null,
    failureReason: null,
    createdAt: new Date(NOW.getTime() - 10 * 60_000),
    updatedAt: NOW,
    ...over,
  };
}

const pending = (): BrandRequest => ({
  id: randomUUID(),
  brandName: "Blood Sugar Friendly",
  brandUrl: "https://bloodsugarfriendly.com/",
  companyId: null,
  status: "pending",
  failureReason: null,
  summary: null,
});

function intake(live: BrandEnrichmentRun[] = []) {
  const runs = {
    live,
    liveRequestRuns: vi.fn(async () => [...runs.live]),
    update: vi.fn(async (runId: string, change: Partial<BrandEnrichmentRun>) => {
      const index = runs.live.findIndex((item) => item.runId === runId);
      runs.live[index] = { ...runs.live[index], ...change } as BrandEnrichmentRun;
      return runs.live[index] as BrandEnrichmentRun;
    }),
  };
  const waits = { waitPending: vi.fn(async (): Promise<BrandRequest[]> => [pending()]) };
  const api = {
    // A claim starts a live run, as the operators' API does.
    claimPending: vi.fn(async (limit: number): Promise<BrandClaimResult[]> => {
      const started = Array.from({ length: limit }, () => run({ createdAt: NOW }));
      runs.live.push(...started);
      return started.map((item) => ({ requestId: item.requestId ?? "", runId: item.runId }));
    }),
    cancel: vi.fn(async () => {}),
  };
  const alerts = { timedOut: vi.fn(async () => {}) };
  const request = requests();
  const log = { info: vi.fn(), warn: vi.fn() };
  const service = new BrandRequestIntake({
    waits,
    requests: request,
    runs,
    api,
    alerts,
    settings: { maxLiveRuns: 1, waitMs: 25_000, timeoutMs: 2 * HOUR },
    log,
    now: () => NOW,
  });
  return { service, runs, waits, api, alerts, request, log };
}

it("long-polls and claims into the free slot as soon as a request is pending", async () => {
  const { service, waits, api } = intake();
  await expect(service.listen(signal)).resolves.toBe("claimed");
  expect(waits.waitPending).toHaveBeenCalledWith(1, 25_000, signal);
  expect(api.claimPending).toHaveBeenCalledWith(1, signal);
});

it("does not wait or claim while the one slot is taken (owner: one at a time)", async () => {
  const { service, waits, api } = intake([run()]);
  await expect(service.listen(signal)).resolves.toBe("busy");
  expect(waits.waitPending).not.toHaveBeenCalled();
  expect(api.claimPending).not.toHaveBeenCalled();
});

it("comes back idle when the long poll ran out with nothing pending", async () => {
  const { service, waits, api } = intake();
  waits.waitPending.mockResolvedValueOnce([]);
  await expect(service.listen(signal)).resolves.toBe("idle");
  expect(api.claimPending).not.toHaveBeenCalled();
});

it("reports stuck when every pending request failed to start, so the loop pauses", async () => {
  const { service, api } = intake();
  api.claimPending.mockResolvedValueOnce([{ requestId: "r1", error: "boom" }]);
  await expect(service.listen(signal)).resolves.toBe("stuck");
});

it("a retail-site skip is progress, not stuck", async () => {
  const { service, api } = intake();
  api.claimPending.mockResolvedValueOnce([
    { requestId: "r1", skipped: "retail_site", site: "gnc.com" },
  ]);
  await expect(service.listen(signal)).resolves.toBe("claimed");
});

it("the long poll and the fallback round never claim into the same slot", async () => {
  const { service, api, runs } = intake();
  await Promise.all([service.listen(signal), service.sweep(signal)]);
  expect(api.claimPending).toHaveBeenCalledTimes(1);
  expect(runs.live).toHaveLength(1);
});

it("the fallback round claims without the long poll", async () => {
  const { service, waits, api } = intake();
  await service.sweep(signal);
  expect(waits.waitPending).not.toHaveBeenCalled();
  expect(api.claimPending).toHaveBeenCalledWith(1, signal);
});

it("fails, stops and reports a request run past 2 h, once; its slot is free again", async () => {
  const stuck = run({ createdAt: new Date(NOW.getTime() - 2 * HOUR - 1) });
  const { service, request, api, alerts, runs } = intake([stuck]);

  await service.sweep(signal);

  expect(request.update).toHaveBeenCalledWith(
    expect.objectContaining({
      id: stuck.requestId,
      status: "failed",
      reason: expect.stringMatching(/^Timeout: still in progress after 2 h/),
    }),
    signal,
  );
  expect(runs.update).toHaveBeenCalledWith(
    stuck.runId,
    expect.objectContaining({ stage: "timed_out" }),
  );
  expect(api.cancel).toHaveBeenCalledWith(stuck.runId, signal);
  expect(alerts.timedOut).toHaveBeenCalledWith(
    expect.objectContaining({ runId: stuck.runId }),
    2 * HOUR,
  );
  // The timed-out run no longer holds the slot: the next pending request is claimed in the same round.
  expect(api.claimPending).toHaveBeenCalledWith(1, signal);

  // The cancel has not landed yet and the workflow moved its stage on: only the stop is tried again.
  const index = runs.live.findIndex((item) => item.runId === stuck.runId);
  runs.live[index] = { ...(runs.live[index] as BrandEnrichmentRun), stage: "apollo" };
  await service.sweep(signal);
  expect(request.update).toHaveBeenCalledTimes(1);
  expect(alerts.timedOut).toHaveBeenCalledTimes(1);
  expect(api.cancel).toHaveBeenCalledTimes(2);
});

it("leaves a run younger than the timeout alone", async () => {
  const { service, request, api } = intake([run({ createdAt: new Date(NOW.getTime() - HOUR) })]);
  await service.sweep(signal);
  expect(request.update).not.toHaveBeenCalled();
  expect(api.cancel).not.toHaveBeenCalled();
  expect(api.claimPending).not.toHaveBeenCalled();
});

it("a failing alert or cancel does not stop the round", async () => {
  const stuck = run({ createdAt: new Date(NOW.getTime() - 3 * HOUR) });
  const { service, api, alerts, log } = intake([stuck]);
  alerts.timedOut.mockRejectedValueOnce(new Error("feishu down"));
  api.cancel.mockRejectedValueOnce(new Error("api down"));
  await expect(service.sweep(signal)).resolves.toBeUndefined();
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({ runId: stuck.runId }),
    "brand request timeout alert failed",
  );
  expect(api.claimPending).toHaveBeenCalled();
});
