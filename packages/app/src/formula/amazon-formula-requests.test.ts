import { describe, expect, it, vi } from "vitest";
import type { QueuedProduct } from "../queue/queue-model.js";
import { AmazonFormulaRequests, type AmazonFormulaQueue } from "./amazon-formula-requests.js";
import type { FamilyFormulaOutcome } from "../queue/family-formula-outcome.js";

const brandId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const amazonSource = "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function queue(source: string | null): AmazonFormulaQueue & { lists: unknown[] } {
  const lists: unknown[] = [];
  const seen = new Set<string>();
  return {
    lists,
    amazonSourceOf: vi.fn(async () => source),
    holdAmazonProducts: vi.fn(async (list) => {
      lists.push(list);
      const fresh = !seen.has(list.batchId);
      seen.add(list.batchId);
      return { added: fresh ? 1 : 0 };
    }),
  };
}

const amazonProduct = (asin: string, sourceId: string): QueuedProduct => ({
  sourceId,
  url: `https://www.amazon.com/dp/${asin}`,
  listingId: asin,
  variantId: null,
});

const metrics = {
  operationId: "wf-metrics",
  runId: brandId,
  channel: "wholefoods" as const,
  variantId: null,
  archiveKey: "retained/wf.html",
};
it.each([null, amazonSource])(
  "durably records metrics and the actual dependency outcome (source %s)",
  async (source) => {
    const held = queue(source);
    const receipts: FamilyFormulaOutcome[] = [];
    held.recordFamilyOutcome = vi.fn(async (row) => {
      receipts.push(row);
    });
    const service = new AmazonFormulaRequests({ queue: held, amazonProduct });
    await service.request({ brandId, asin: "B0096M5PBW", metrics });
    expect(receipts.map((row) => row.status)).toEqual([
      "metrics-complete",
      source ? "formula-pending" : "no-amazon-source",
    ]);
    expect(receipts[1]).toMatchObject({
      ...metrics,
      listingId: "B0096M5PBW",
      formulaOperationId: null,
    });
  },
);

it("records a known formula without adding any Amazon work", async () => {
  const held = queue(null);
  held.recordFamilyOutcome = vi.fn(async () => undefined);
  const service = new AmazonFormulaRequests({ queue: held, amazonProduct });
  expect(
    await service.request({
      brandId,
      asin: "B0096M5PBW",
      metrics,
      formulaOperationId: "amazon-label",
    }),
  ).toMatchObject({ status: "formula-linked", operationId: "amazon-label" });
  expect(held.recordFamilyOutcome).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: "formula-linked",
      formulaOperationId: "amazon-label",
    }),
  );
  expect(held.holdAmazonProducts).not.toHaveBeenCalled();
});

it("does not report formula pending or start paid work if the metrics receipt cannot be persisted", async () => {
  const held = queue(amazonSource);
  held.recordFamilyOutcome = vi.fn(async () => {
    throw new Error("database unavailable");
  });
  const service = new AmazonFormulaRequests({ queue: held, amazonProduct });
  await expect(service.request({ brandId, asin: "B0096M5PBW", metrics })).rejects.toThrow(
    "database unavailable",
  );
  expect(held.holdAmazonProducts).not.toHaveBeenCalled();
});

describe("Amazon formula requests", () => {
  it("holds an ASIN without an Amazon formula in Amazon's queue once", async () => {
    const held = queue(amazonSource);
    const requests = new AmazonFormulaRequests({ queue: held, amazonProduct });
    expect(await requests.request({ brandId, asin: "b002cqu54q" })).toEqual({
      status: "queued",
      listingId: "B002CQU54Q",
    });
    expect(await requests.request({ brandId, asin: "B002CQU54Q" })).toEqual({
      status: "already-queued",
      listingId: "B002CQU54Q",
    });
    expect(held.lists[0]).toMatchObject({
      products: [
        {
          sourceId: amazonSource,
          url: "https://www.amazon.com/dp/B002CQU54Q",
          listingId: "B002CQU54Q",
        },
      ],
    });
    expect(held.lists[0]).toEqual(held.lists[1]);
  });

  it("a brand with no Amazon source holds nothing and says so", async () => {
    const held = queue(null);
    const requests = new AmazonFormulaRequests({ queue: held, amazonProduct });
    expect(await requests.request({ brandId, asin: "B002CQU54Q" })).toEqual({
      status: "no-amazon-source",
      listingId: "B002CQU54Q",
    });
    expect(held.holdAmazonProducts).not.toHaveBeenCalled();
  });
});
