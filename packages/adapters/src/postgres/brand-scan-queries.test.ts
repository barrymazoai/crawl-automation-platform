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
  });
});
