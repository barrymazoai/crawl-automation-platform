import { describe, expect, it, vi } from "vitest";
import { RunScans } from "./run-scans.js";
import type { ScanRecord, ScanResult } from "./scan-model.js";

const requestId = "44444444-4444-4444-8444-444444444444";
const sourceId = "33333333-3333-4333-8333-333333333333";
const scanId = "55555555-5555-4555-8555-555555555555";

function record(state: ScanRecord["state"], result: Partial<ScanResult> | null): ScanRecord {
  return {
    scanId,
    requestId,
    source: {
      sourceId,
      brandId: "22222222-2222-4222-8222-222222222222",
      brandName: "Nordic Naturals",
      channel: "gnc",
      url: "https://www.gnc.com/brands/nordic-naturals/",
      enabled: true,
    },
    revisitBatchId: "66666666-6666-4666-8666-666666666666",
    state,
    result: result as ScanResult | null,
    requestedAt: "2026-09-30T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
  };
}

describe("RunScans", () => {
  it("reports a running scan without counts", async () => {
    const store = { byRequest: vi.fn(async () => record("running", null)) };
    expect(await new RunScans(store).scanOf({ requestId, sourceId })).toEqual({
      scanId,
      state: "running",
      queued: null,
      code: null,
    });
    expect(store.byRequest).toHaveBeenCalledWith(requestId, sourceId);
  });

  it("reports what a finished scan queued, and a Review's code", async () => {
    const done = { byRequest: vi.fn(async () => record("complete", { queued: 48, code: null })) };
    expect(await new RunScans(done).scanOf({ requestId, sourceId })).toMatchObject({
      state: "complete",
      queued: 48,
    });
    const review = {
      byRequest: vi.fn(async () => record("review", { queued: 0, code: "BRAND_SCAN.URL" })),
    };
    expect(await new RunScans(review).scanOf({ requestId, sourceId })).toMatchObject({
      state: "review",
      code: "BRAND_SCAN.URL",
    });
  });

  it("refuses a run whose scan was never requested", async () => {
    const store = { byRequest: vi.fn(async () => null) };
    await expect(new RunScans(store).scanOf({ requestId, sourceId })).rejects.toMatchObject({
      code: "RUN.SCAN_MISSING",
    });
  });
});
