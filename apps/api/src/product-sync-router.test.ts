import { expect, it, vi } from "vitest";
import { appWith, post, query } from "./testing/app-with.js";

it("matches brands without authentication and passes cancellation to the service", async () => {
  const result = { checked: 1, matched: 1, ambiguous: 0, unmatched: 0, errors: [] };
  const matchBrands = vi.fn(async () => result);
  const input = { limit: 10, recheckUnmatched: true };
  const response = await appWith({ productSync: { matchBrands } }).request(
    "/trpc/productSync.matchBrands",
    post(input),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ result: { data: result } });
  expect(matchBrands).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal));
});

it("lists by status with a default bounded limit", async () => {
  const brands = vi.fn(async () => []);
  const response = await appWith({ productSync: Promise.resolve({ brands }) }).request(
    `/trpc/productSync.brands${query({ status: "ambiguous" })}`,
  );
  expect(response.status).toBe(200);
  expect(brands).toHaveBeenCalledExactlyOnceWith({ status: "ambiguous", limit: 100 });
});

it.each([0, 501, 1.5])(
  "rejects an invalid matching limit %s before calling the service",
  async (limit) => {
    const matchBrands = vi.fn();
    const response = await appWith({ productSync: { matchBrands } }).request(
      "/trpc/productSync.matchBrands",
      post({ limit }),
    );
    expect(response.status).toBe(400);
    expect(matchBrands).not.toHaveBeenCalled();
  },
);

it.each([{ status: "error" }, { limit: 501 }, { limit: 0 }])(
  "rejects an invalid brands filter %j",
  async (input) => {
    const brands = vi.fn();
    const response = await appWith({ productSync: { brands } }).request(
      `/trpc/productSync.brands${query(input)}`,
    );
    expect(response.status).toBe(400);
    expect(brands).not.toHaveBeenCalled();
  },
);

it("returns a registered error when Supply Smart is not configured", async () => {
  const response = await appWith({}).request(`/trpc/productSync.brands${query({})}`);
  expect(response.status).toBe(500);
  expect(await response.text()).toContain("PRODUCT_SYNC.NOT_CONFIGURED");
});

it("defaults listing-date reopen to preview and returns the bounded selection", async () => {
  const result = {
    reopened: 0,
    eligible: 23456,
    selected: [{ listingId: "B0013LAQS6", variantId: null }],
    originals: {
      checked: 1,
      noReadableOriginal: 1,
      warnings: [{ listingId: "B0013LAQS6", runId: "capture", reason: "missing" }],
    },
  };
  const reopen = vi.fn(async () => result);
  const input = { channel: "amazon", listingDates: true, before: "2026-10-22T00:00:00Z", limit: 1 };
  const response = await appWith({ productSync: { reopen } }).request(
    "/trpc/productSync.reopen",
    post(input),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ result: { data: result } });
  expect(reopen).toHaveBeenCalledExactlyOnceWith(
    { ...input, dryRun: true },
    expect.any(AbortSignal),
  );
});

it("rejects listing-date requests for another channel before service access", async () => {
  const reopen = vi.fn();
  const response = await appWith({ productSync: { reopen } }).request(
    "/trpc/productSync.reopen",
    post({
      channel: "wholefoods",
      listingDates: true,
      before: "2026-10-22T00:00:00Z",
      limit: 1,
      dryRun: false,
    }),
  );
  expect(response.status).toBe(400);
  expect(reopen).not.toHaveBeenCalled();
});
