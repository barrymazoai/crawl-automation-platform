import { expect, it, vi } from "vitest";
import { EnrichmentBackfill } from "./backfill.js";
import type { SharedEnrichmentRecord } from "@crawl-automation/v3-contracts";

const product = { collectionOperationId: "collection", channel: "gnc" as const };
function setup() {
  const repository = {
    missing: vi.fn(async () => [product]),
    outdated: vi.fn(async () => [{ ...product, listingId: "outdated" }]),
  };
  const starter = { start: vi.fn(async () => ({ workflowId: "enrich-one" })) };
  return { repository, starter, service: new EnrichmentBackfill(repository, starter) };
}
it("listing missing enrichment never dispatches work", async () => {
  const state = setup();
  expect(await state.service.list(7)).toEqual([product]);
  expect(state.repository.missing).toHaveBeenCalledWith(7);
  expect(state.starter.start).not.toHaveBeenCalled();
});
it("starts only the approved bounded selection once, serially", async () => {
  const state = setup();
  expect(
    await state.service.run({ limit: 2, approvedCount: 2, products: [product, product] }),
  ).toMatchObject({ selected: 1, approvedCount: 2 });
  expect(state.starter.start).toHaveBeenCalledTimes(1);
  expect(state.repository.missing).not.toHaveBeenCalled();
});
it("refuses counts above approval or limits before any dispatch", async () => {
  const state = setup();
  await expect(state.service.run({ limit: 2, approvedCount: 1 })).rejects.toMatchObject({
    code: "ENRICH.BACKFILL_INVALID",
  });
  await expect(state.service.run({ limit: 101, approvedCount: 101 })).rejects.toThrow();
  expect(state.starter.start).not.toHaveBeenCalled();
});
it("without an explicit list, selects at most the approved count", async () => {
  const state = setup();
  await state.service.run({ limit: 1, approvedCount: 1 });
  expect(state.repository.missing).toHaveBeenCalledWith(1);
  expect(state.starter.start).toHaveBeenCalledWith(product);
});
it("selects sent products on an older protocol only when asked (owner 2026-10-26)", async () => {
  const state = setup();
  await state.service.run({ limit: 3, approvedCount: 3, selection: "outdated" });
  expect(state.repository.outdated).toHaveBeenCalledWith(3);
  expect(state.repository.missing).not.toHaveBeenCalled();
  expect(state.starter.start).toHaveBeenCalledWith({ ...product, listingId: "outdated" });
  expect(await state.service.outdated(5)).toEqual([{ ...product, listingId: "outdated" }]);
  expect(() => state.service.outdated(101)).toThrow();
});
it("returns the persisted enrichment without dispatching a workflow", async () => {
  const record = { candidate: { unifiedName: "Vitamin D" } } as SharedEnrichmentRecord;
  const repository = {
    missing: vi.fn(async () => []),
    outdated: vi.fn(async () => []),
    readSubject: vi.fn(async () => record),
  };
  const starter = { start: vi.fn() };
  const service = new EnrichmentBackfill(repository, starter);
  expect(await service.result(product)).toEqual(record);
  expect(repository.readSubject).toHaveBeenCalledWith(product);
  expect(starter.start).not.toHaveBeenCalled();
});
it("fails closed if a selection adapter exceeds the approved count", async () => {
  const state = setup();
  state.repository.missing.mockResolvedValue([product, product]);
  await expect(state.service.run({ limit: 1, approvedCount: 1 })).rejects.toMatchObject({
    code: "ENRICH.BACKFILL_INVALID",
  });
  expect(state.starter.start).not.toHaveBeenCalled();
});

it("reads a backfill workflow's status only for its own workflow IDs", async () => {
  const repository = { missing: vi.fn(), outdated: vi.fn() };
  const status = vi.fn(async () => ({ status: "COMPLETED", outcome: { status: "registered" } }));
  const service = new EnrichmentBackfill(repository, { start: vi.fn(), status });
  const id = `product-enrichment-${"a".repeat(64)}`;
  expect(await service.workflow(id)).toEqual({
    status: "COMPLETED",
    outcome: { status: "registered" },
  });
  expect(status).toHaveBeenCalledWith(id);
  expect(() => service.workflow("product-run-x")).toThrow();
});
