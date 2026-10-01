import { describe, expect, it, vi } from "vitest";
import { appWith, query } from "./testing/app-with.js";

const brandId = "22222222-2222-4222-8222-222222222222";

describe("source discovery without authentication", () => {
  it.each([
    { channel: "amazon", enabled: false, scanned: true, limit: 10, offset: 20 },
    { channel: "gnc", scanned: false },
    { brandId },
    { brandId, channel: "amazon", enabled: true },
  ])("passes source filters and default pagination: %j", async (input) => {
    const page = {
      items: [
        { id: "source", revision: 3, brandName: "Brand", lastScan: null, queueProductCount: 0 },
      ],
      hasMore: false,
    };
    const sources = vi.fn(async () => page);
    const response = await appWith({ brands: { sources } }).request(
      `/trpc/brands.sources${query(input)}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: page } });
    expect(sources).toHaveBeenCalledExactlyOnceWith({ limit: 25, offset: 0, q: "", ...input });
  });

  it.each([
    {},
    { channel: "unknown" },
    { brandId: "invalid" },
    { channel: "amazon", scanned: "true" },
    { channel: "amazon", enabled: 1 },
    { channel: "amazon", offset: -1 },
    { channel: "amazon", limit: 101 },
    { channel: "amazon", extra: true },
  ])("rejects invalid or unscoped source filters: %j", async (input) => {
    const sources = vi.fn();
    const response = await appWith({ brands: { sources } }).request(
      `/trpc/brands.sources${query(input)}`,
    );
    expect(response.status).toBe(400);
    expect(sources).not.toHaveBeenCalled();
  });
});
