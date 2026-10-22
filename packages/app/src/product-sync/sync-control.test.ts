import { expect, it, vi } from "vitest";
import { ProductSyncControl } from "./sync-control.js";
import type { ProductSyncLedger } from "./ledger.js";

const input = {
  channel: "amazon" as const,
  listingDates: true as const,
  before: "2026-10-22T00:00:00Z",
  limit: 200,
};
const setup = () => {
  const reopen = vi.fn(async () => ({ reopened: 0, eligible: 123, selected: [] }));
  const inspect = vi.fn(async () => ({ checked: 0, noReadableOriginal: 0, warnings: [] }));
  return {
    reopen,
    inspect,
    service: new ProductSyncControl({
      ledger: { reopen } as unknown as ProductSyncLedger,
      listingDateOriginals: { inspect },
    }),
  };
};

it("defaults the DFA control to a bounded read-only preview and returns its exact count", async () => {
  const { service, reopen, inspect } = setup();
  expect(await service.reopen({ ...input, dryRun: true })).toEqual({
    reopened: 0,
    eligible: 123,
    selected: [],
    originals: { checked: 0, noReadableOriginal: 0, warnings: [] },
  });
  expect(reopen).toHaveBeenCalledExactlyOnceWith({ ...input, dryRun: true });
  expect(inspect).toHaveBeenCalledExactlyOnceWith([], expect.any(AbortSignal));
});

it("unconfigured original inspection refuses a backfill before changing its watermarks", async () => {
  const reopen = vi.fn();
  const service = new ProductSyncControl({ ledger: { reopen } as unknown as ProductSyncLedger });
  await expect(service.reopen({ ...input, dryRun: false })).rejects.toMatchObject({
    code: "PRODUCT_SYNC.ORIGINALS_NOT_CONFIGURED",
  });
  expect(reopen).not.toHaveBeenCalled();
});

it("requires explicit execution and preserves the selected ASIN pilot and cutoff", async () => {
  const { service, reopen } = setup();
  const selected = { ...input, listingIds: ["B0013LAQS6"], limit: 1, dryRun: false };
  await service.reopen(selected);
  expect(reopen).toHaveBeenCalledExactlyOnceWith(selected);
});

it.each([
  { channel: "wholefoods" },
  { limit: 201 },
  { before: "yesterday" },
  { before: "9999-01-01T00:00:00Z" },
  { listingIds: ["invalid"] },
])("refuses unsafe DFA filters %j before repository access", async (change) => {
  const { service, reopen } = setup();
  expect(() => service.reopen({ ...input, dryRun: false, ...change } as never)).toThrow();
  expect(reopen).not.toHaveBeenCalled();
});
