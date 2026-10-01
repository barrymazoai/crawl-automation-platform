import { expect, it, vi } from "vitest";
import type { EnrichmentBackfill } from "@crawl-automation/app";
import type { ApiContext } from "../trpc.js";
import { enrichmentRouter } from "./enrichment.js";

it("validates bounded count and exposes the candidate returned by the service", async () => {
  const product = { channel: "gnc" as const, collectionOperationId: "collection" };
  const result = { candidate: { unifiedName: "Vitamin D" }, evidenceKey: "enrichment/record.json" };
  const enrichment = {
    list: vi.fn(async () => [product]),
    run: vi.fn(async () => ({ selected: 1 })),
    result: vi.fn(async () => result),
  } as unknown as EnrichmentBackfill;
  const caller = enrichmentRouter.createCaller({ enrichment } as ApiContext);
  expect(await caller.missing({ limit: 1 })).toEqual([product]);
  expect(await caller.result(product)).toEqual(result);
  await expect(caller.run({ limit: 101, approvedCount: 101 })).rejects.toThrow();
  expect(enrichment.run).not.toHaveBeenCalled();
  expect(await caller.run({ limit: 1, approvedCount: 1, products: [product] })).toEqual({
    selected: 1,
  });
});
