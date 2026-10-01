import { describe, expect, it } from "vitest";
import { scanOf } from "./brand-scan-queries.js";

const result = {
  state: "complete",
  pages: 1,
  products: 3,
  families: 0,
  unresolvedFamilies: 0,
  statedTotal: null,
  full: true,
  newListings: 3,
  knownListings: 0,
  missing: 0,
  queued: 3,
  credits: 0,
  code: null,
};

const row = (scanResult: Record<string, unknown>) => ({
  sourceId: "source-1",
  brandId: "brand-1",
  brandName: "Example",
  channel: "wholefoods",
  url: "https://www.wholefoodsmarket.com/grocery/search?k=Example",
  enabled: true,
  scanId: "scan-1",
  requestId: "request-1",
  revisitBatchId: "batch-1",
  state: "complete",
  result: scanResult,
  requestedAt: "2026-09-30T12:00:00.000Z",
  startedAt: "2026-09-30T12:00:01.000Z",
  finishedAt: "2026-09-30T12:00:09.000Z",
});

describe("brand scan result decoding", () => {
  it.each([true, false])("keeps soldHere=%s from a browser scan", (soldHere) => {
    expect(scanOf(row({ ...result, soldHere })).result).toMatchObject({ soldHere });
  });

  it("reads a result saved before soldHere existed", () => {
    expect(scanOf(row(result)).result).not.toHaveProperty("soldHere");
    expect(scanOf(row(result)).result).not.toHaveProperty("nameResolution");
  });

  it.each([true, false])("retains name resolution evidence with fallback=%s", (usedFallback) => {
    const nameResolution = { brandName: "Brand® Inc.", usedFallback };
    expect(scanOf(row({ ...result, nameResolution })).result).toMatchObject({ nameResolution });
  });
});

it("round-trips HTTP observation accounting in partial and review JSON records", () => {
  const metrics = {
    storeId: "10259",
    unionSize: 0,
    attempts: [
      {
        read: "read-1",
        page: 1,
        attempt: 1,
        url: "https://example.test/search",
        archiveKey: "first.json",
        creditCost: 1,
        fromArchive: false,
        empty: true,
        code: null,
      },
    ],
    reads: [
      {
        read: "read-1",
        pages: 0,
        cards: 0,
        products: 0,
        availableCounts: [],
        succeeded: false,
        code: "WHOLEFOODS.SEARCH_THROTTLED",
      },
    ],
  };
  for (const state of ["partial", "review"]) {
    const saved = {
      ...result,
      state,
      full: false,
      metrics,
      cooldownRequested: true,
      credits: 1,
      code: "WHOLEFOODS.SEARCH_THROTTLED",
    };
    expect(scanOf(row(saved)).result).toEqual(saved);
  }
});
